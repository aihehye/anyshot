import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EditableSource, HistoryEntry } from '../shared/ipc';
import { type PerfMetrics, roundMs } from '../shared/perf';
import { isProjectDoc, type Project, packProject, unpackProject } from '../shared/project';
import { isRecord } from '../shared/schema';
import { readJson, writeFileAtomic } from './atomic-file';
import { paths } from './paths';
import { registerMediaRoute } from './protocol';
import { serialQueue } from './serial';
import { getSettings } from './settings-store';
import { send, windowsOf } from './windows';

/**
 * Capture history: one PNG and one WebP thumbnail per entry plus a JSON index,
 * all under userData/history. Thumbnails are written at capture time so the
 * history window never decodes full images. Annotated entries also keep an
 * `.anyshot` project (original pixels + annotation document) so they reopen
 * editable; the PNG stays the rendered result used for copy, pin and export.
 */
let entries: HistoryEntry[] | null = null;
let loading: Promise<HistoryEntry[]> | null = null;
let dirCreatedFor: string | null = null;
/** Serialises index updates so concurrent captures can't lose entries. */
const serial = serialQueue();
/** How many consumers (pins, previews, editors, a delivery) hold each entry. */
const holds = new Map<string, number>();
/** Entries queued for background disk flush, served immediately from memory until persisted. */
const pendingEntries = new Map<string, HistoryEntry>();
const pendingMedia = new Map<string, { png: Uint8Array; thumb?: Uint8Array }>();
const pendingWrites = new Map<string, Promise<void>>();

const indexFile = () => join(paths.historyDir, 'index.json');
export const imagePath = (id: string) => join(paths.historyDir, `${id}.png`);
export const thumbPath = (id: string) => join(paths.historyDir, `${id}.thumb.webp`);
export const projectPath = (id: string) => join(paths.historyDir, `${id}.anyshot`);

async function ensureHistoryDir(): Promise<void> {
  const dir = paths.historyDir;
  if (dirCreatedFor === dir) return;
  await mkdir(dir, { recursive: true });
  dirCreatedFor = dir;
}

function detectImageMime(bytes: Uint8Array, fallback: string): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return fallback;
}

function isEntry(v: unknown): v is HistoryEntry {
  const e = v as HistoryEntry;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.id === 'string' &&
    /^[\w-]+$/.test(e.id) &&
    typeof e.createdAt === 'number' &&
    typeof e.width === 'number' &&
    typeof e.height === 'number'
  );
}

async function load(): Promise<HistoryEntry[]> {
  if (entries) return entries;
  loading ??= readJson(indexFile())
    .then((raw) => {
      if (raw !== undefined && !Array.isArray(raw)) throw new Error('Invalid history index');
      entries = raw?.filter(isEntry) ?? [];
      return entries;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function persist(next: HistoryEntry[]): Promise<void> {
  await writeFileAtomic(indexFile(), JSON.stringify(next, null, 1));
  entries = next;
  // Open history windows reload, so captures finished after they opened still appear.
  for (const win of windowsOf('history')) send(win, 'history:changed', undefined);
}

/**
 * Entries used by open pins, previews or editors survive pruning until every
 * holder has released them. Each retain must be balanced by one release.
 */
export function retain(id: string): void {
  holds.set(id, (holds.get(id) ?? 0) + 1);
}

export function release(id: string): void {
  const count = (holds.get(id) ?? 0) - 1;
  if (count > 0) holds.set(id, count);
  else holds.delete(id);
  void serial(prune).catch((error) => console.error('[history] pruning failed', error));
}

function removeFiles(list: readonly HistoryEntry[]): Promise<unknown> {
  return Promise.all(
    list.flatMap((e) => [
      rm(imagePath(e.id), { force: true }),
      rm(thumbPath(e.id), { force: true }),
      rm(projectPath(e.id), { force: true }),
    ]),
  );
}

async function prune(): Promise<void> {
  const list = await load();
  const limit = getSettings().output.historySize;
  const keep: HistoryEntry[] = [];
  const drop: HistoryEntry[] = [];
  for (const [i, entry] of list.entries()) {
    (i < limit || holds.has(entry.id) ? keep : drop).push(entry);
  }
  if (drop.length === 0) return;
  await persist(keep);
  await removeFiles(drop);
}

const isSide = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/**
 * Accepts an editable source from a window only if it is a PNG with a
 * well-formed document; anything else is stored as a plain image. The shape
 * is checked too: a renderer's payload is untrusted, and a broken one must
 * not fail the whole delivery.
 */
export function checkEditable(edit: unknown): EditableSource | undefined {
  if (edit === undefined) return undefined;
  const source = isRecord(edit) ? edit.source : undefined;
  if (
    isRecord(edit) &&
    isRecord(source) &&
    source.mime === 'image/png' &&
    source.bytes instanceof ArrayBuffer &&
    source.bytes.byteLength > 0 &&
    isSide(source.width) &&
    isSide(source.height) &&
    isProjectDoc(edit.doc, { width: source.width, height: source.height })
  ) {
    return {
      doc: edit.doc,
      source: {
        mime: 'image/png',
        bytes: source.bytes,
        width: source.width,
        height: source.height,
      },
    };
  }
  console.warn('[history] ignoring a malformed annotation document');
  return undefined;
}

async function readIfExists(file: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writes (or, without an edit, removes) the entry's editable project. */
async function writeEditable(id: string, edit: EditableSource | undefined): Promise<void> {
  if (!edit) {
    await rm(projectPath(id), { force: true });
    return;
  }
  const { width, height, bytes } = edit.source;
  await writeFileAtomic(
    projectPath(id),
    packProject({
      doc: edit.doc,
      image: { mime: 'image/png', width, height },
      bytes: new Uint8Array(bytes),
    }),
  );
}

/**
 * The entry's original pixels and annotation document, or null when it only
 * has a rendered image (older entries, plain captures) or the stored project
 * is malformed; callers then open the rendered image instead.
 */
export async function readEditable(id: string): Promise<Project | null> {
  const write = pendingWrites.get(id);
  if (write) await write;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(projectPath(id)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('[history] could not read the document of', id, error);
    return null;
  }
  try {
    const project = unpackProject(bytes);
    if (project.image.mime === 'image/png' && isProjectDoc(project.doc, project.image))
      return project;
  } catch {
    // Reported below like any other malformed project.
  }
  console.warn('[history] ignoring the malformed document of', id);
  return null;
}

export interface QueueEntryInput {
  png: Uint8Array;
  thumb?: ArrayBuffer | Uint8Array | (() => Uint8Array | ArrayBuffer | undefined);
  width: number;
  height: number;
  savedPath?: string | null;
  edit?: EditableSource;
}

export function addEntry(
  input: {
    png: Uint8Array;
    thumb?: ArrayBuffer;
    width: number;
    height: number;
    savedPath?: string | null;
    edit?: EditableSource;
  },
  perf?: PerfMetrics,
): Promise<HistoryEntry> {
  return serial(async () => {
    const loadT0 = performance.now();
    const list = await load();
    if (perf) perf.history_load = roundMs(performance.now() - loadT0);
    await ensureHistoryDir();
    const entry: HistoryEntry = {
      id: randomUUID(),
      createdAt: Date.now(),
      width: input.width,
      height: input.height,
      kind: 'image',
      savedPath: input.savedPath ?? null,
    };
    try {
      const pngT0 = performance.now();
      await writeFile(imagePath(entry.id), input.png);
      if (perf) perf.history_png_write = roundMs(performance.now() - pngT0);
      if (input.thumb) {
        const thumbT0 = performance.now();
        await writeFile(thumbPath(entry.id), new Uint8Array(input.thumb));
        if (perf) perf.history_thumb_write = roundMs(performance.now() - thumbT0);
      }
      if (input.edit) {
        const editT0 = performance.now();
        await writeEditable(entry.id, input.edit);
        if (perf) perf.history_edit_write = roundMs(performance.now() - editT0);
      }
      const persistT0 = performance.now();
      await persist([entry, ...list]);
      if (perf) perf.history_index_persist = roundMs(performance.now() - persistT0);
    } catch (error) {
      await removeFiles([entry]).catch(() => undefined);
      throw error;
    }
    retain(entry.id);
    return entry;
  });
}

/**
 * Registers and retains a history entry immediately in memory while flushing
 * PNG, thumbnail, editable project and `index.json` writes asynchronously in
 * the serialized background queue.
 */
export function queueEntry(input: QueueEntryInput, perf?: PerfMetrics): HistoryEntry {
  const t0 = performance.now();
  const entry: HistoryEntry = {
    id: randomUUID(),
    createdAt: Date.now(),
    width: input.width,
    height: input.height,
    kind: 'image',
    savedPath: input.savedPath ?? null,
  };
  retain(entry.id);
  pendingEntries.set(entry.id, entry);
  const eagerThumb =
    typeof input.thumb === 'function'
      ? undefined
      : input.thumb
        ? new Uint8Array(input.thumb)
        : undefined;
  pendingMedia.set(entry.id, {
    png: input.png,
    ...(eagerThumb ? { thumb: eagerThumb } : {}),
  });

  const writePromise = serial(async () => {
    // Yield one turn so deliver() and IPC reply complete before thumbnail encoding or disk I/O.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await ensureHistoryDir();
      const list = await load();
      const rawThumb = typeof input.thumb === 'function' ? input.thumb() : input.thumb;
      const thumbArr = rawThumb ? new Uint8Array(rawThumb) : undefined;
      const media = pendingMedia.get(entry.id);
      if (media && thumbArr) media.thumb = thumbArr;
      await Promise.all([
        writeFile(imagePath(entry.id), input.png),
        ...(thumbArr ? [writeFile(thumbPath(entry.id), thumbArr)] : []),
        ...(input.edit ? [writeEditable(entry.id, input.edit)] : []),
      ]);
      await persist([entry, ...list]);
    } catch (error) {
      await removeFiles([entry]).catch(() => undefined);
      console.error('[history] background write failed', error);
    } finally {
      pendingEntries.delete(entry.id);
      pendingMedia.delete(entry.id);
      pendingWrites.delete(entry.id);
    }
  });
  pendingWrites.set(entry.id, writePromise);
  if (perf) perf.history_queue = roundMs(performance.now() - t0);
  return entry;
}

/** Waits until all queued history writes and pruning tasks have settled. */
export async function flushHistory(): Promise<void> {
  await serial(async () => {});
}

export async function listEntries(): Promise<HistoryEntry[]> {
  const limit = getSettings().output.historySize;
  const disk = await load();
  if (pendingEntries.size === 0) {
    return disk.filter((e, i) => i < limit || holds.has(e.id));
  }
  const pendingList = [...pendingEntries.values()].sort((a, b) => b.createdAt - a.createdAt);
  const merged = [...pendingList, ...disk.filter((e) => !pendingEntries.has(e.id))];
  return merged.filter((e, i) => i < limit || holds.has(e.id));
}

export async function getEntry(id: string): Promise<HistoryEntry | undefined> {
  return pendingEntries.get(id) ?? (await load()).find((e) => e.id === id);
}

export function getRetainedEntry(id: string): Promise<HistoryEntry | undefined> {
  return serial(async () => {
    const entry = await getEntry(id);
    if (entry) retain(id);
    return entry;
  });
}

export function updateEntry(id: string, patch: Partial<Omit<HistoryEntry, 'id'>>): Promise<void> {
  return serial(async () => {
    const list = await load();
    await persist(list.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  });
}

export async function readImage(id: string): Promise<Uint8Array> {
  const media = pendingMedia.get(id);
  if (media) return media.png;
  const write = pendingWrites.get(id);
  if (write) await write;
  return new Uint8Array(await readFile(imagePath(id)));
}

export function removeEntry(id: string): Promise<void> {
  return serial(async () => {
    const list = await load();
    await persist(list.filter((e) => e.id !== id));
    await removeFiles(list.filter((e) => e.id === id));
  });
}

export function clearHistory(): Promise<void> {
  return serial(async () => {
    const list = await load();
    // Decide once: a hold released during the write must not delete a kept entry.
    const keep = list.filter((e) => holds.has(e.id));
    const drop = list.filter((e) => !holds.has(e.id));
    await persist(keep);
    await removeFiles(drop);
  });
}

registerMediaRoute('history', async (rest) => {
  const [id, what] = rest.split('/');
  if (!id || !/^[\w-]+$/.test(id)) return null;
  try {
    if (what === 'thumb') {
      const media = pendingMedia.get(id);
      if (media?.thumb) {
        return new Response(media.thumb as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': detectImageMime(media.thumb, 'image/webp') },
        });
      }
      const write = pendingWrites.get(id);
      if (write) await write;
      // Entries added without a thumbnail (e.g. pinned from the clipboard) fall back to the image.
      const thumb = await readFile(thumbPath(id)).catch(() => null);
      if (thumb) {
        return new Response(thumb, {
          headers: { 'content-type': detectImageMime(thumb, 'image/webp') },
        });
      }
      if (media?.png) {
        return new Response(media.png as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(await readFile(imagePath(id)), {
        headers: { 'content-type': 'image/png' },
      });
    }
    if (what === 'image') {
      const media = pendingMedia.get(id);
      if (media) {
        return new Response(media.png as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': 'image/png' },
        });
      }
      const write = pendingWrites.get(id);
      if (write) await write;
      return new Response(await readFile(imagePath(id)), {
        headers: { 'content-type': 'image/png' },
      });
    }
  } catch {
    return null;
  }
  return null;
});

/**
 * Replaces an entry's image and editable document (edits saved back from the
 * editor); without `edit` the entry becomes a plain image. `savedPath` is
 * updated when the edit was also saved to a file.
 */
export function replaceImage(
  id: string,
  input: {
    png: Uint8Array;
    thumb?: ArrayBuffer;
    width: number;
    height: number;
    savedPath?: string;
    edit?: EditableSource;
  },
): Promise<HistoryEntry | undefined> {
  return serial(async () => {
    const list = await load();
    const entry = list.find((e) => e.id === id);
    if (!entry) return undefined;
    // All or nothing: if any file or the index can't be written, the previous
    // image, thumbnail and project come back, so the entry never shows a new
    // image with an old document (or the reverse).
    const files = [imagePath(id), thumbPath(id), projectPath(id)];
    const previous = await Promise.all(files.map(readIfExists));
    const updated = {
      ...entry,
      width: input.width,
      height: input.height,
      updatedAt: Date.now(),
      ...(input.savedPath ? { savedPath: input.savedPath } : {}),
    };
    try {
      await writeFileAtomic(imagePath(id), input.png);
      if (input.thumb) await writeFileAtomic(thumbPath(id), new Uint8Array(input.thumb));
      await writeEditable(id, input.edit);
      await persist(list.map((e) => (e.id === id ? updated : e)));
    } catch (error) {
      await Promise.all(
        files.map((file, i) => {
          const bytes = previous[i];
          return (bytes ? writeFileAtomic(file, bytes) : rm(file, { force: true })).catch(
            (restoreError: unknown) =>
              console.error('[history] could not restore', file, restoreError),
          );
        }),
      );
      throw error;
    }
    return updated;
  });
}
