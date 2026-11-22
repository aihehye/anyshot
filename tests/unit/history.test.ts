import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// history.ts talks to Electron through these modules; the tests replace them
// and add two hooks to reproduce races deterministically: a delay or failure
// for index reads, and a callback that runs right after each index write.
const state = vi.hoisted(() => ({
  dir: '',
  historySize: 10,
  indexReads: [] as (() => Promise<void>)[],
  afterPersist: undefined as (() => void) | undefined,
  /** Makes atomic writes to matching paths fail. */
  failWrite: undefined as ((path: string) => boolean) | undefined,
}));

vi.mock('../../src/main/atomic-file', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/atomic-file')>();
  return {
    ...real,
    writeFileAtomic: async (...args: Parameters<typeof real.writeFileAtomic>) => {
      if (state.failWrite?.(args[0])) throw new Error(`EIO: cannot write ${args[0]}`);
      return real.writeFileAtomic(...args);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      if (String(args[0]).endsWith('index.json')) await state.indexReads.shift()?.();
      return real.readFile(...args);
    },
  };
});
vi.mock('../../src/main/paths', () => ({
  paths: {
    get historyDir() {
      return state.dir;
    },
  },
}));
vi.mock('../../src/main/protocol', () => ({ registerMediaRoute: () => {} }));
vi.mock('../../src/main/windows', () => ({
  send: () => {},
  windowsOf: () => {
    state.afterPersist?.();
    return [];
  },
}));
vi.mock('../../src/main/settings-store', () => ({
  getSettings: () => ({ output: { historySize: state.historySize } }),
}));

type History = typeof import('../../src/main/history');
let history: History;

const png = new Uint8Array([137, 80, 78, 71]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const indexFile = () => join(state.dir, 'index.json');
const indexIds = async () =>
  (JSON.parse(await fs.readFile(indexFile(), 'utf8')) as { id: string }[]).map((e) => e.id);
/** Waits for queued history work (e.g. the prune a release schedules). */
const settle = () => history.updateEntry('none', {});

beforeEach(async () => {
  state.dir = await fs.mkdtemp(join(tmpdir(), 'anyshot-history-'));
  state.historySize = 10;
  state.indexReads = [];
  state.afterPersist = undefined;
  state.failWrite = undefined;
  vi.resetModules();
  history = await import('../../src/main/history');
});

afterEach(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

async function seed(ids: string[]): Promise<void> {
  const entries = ids.map((id) => ({ id, createdAt: 1, width: 1, height: 1, kind: 'image' }));
  await fs.writeFile(indexFile(), JSON.stringify(entries));
  for (const id of ids) await fs.writeFile(history.imagePath(id), png);
}

describe('history', () => {
  it('shares the first index read, so a slow read cannot drop a new capture', async () => {
    await seed(['old']);
    state.indexReads = [() => sleep(50), async () => {}];
    const [listed, added] = await Promise.all([
      history.listEntries(),
      history.addEntry({ png, width: 1, height: 1 }),
    ]);
    expect(listed.map((e) => e.id)).toContain('old');
    await settle();
    expect(await indexIds()).toEqual([added.id, 'old']);
  });

  it('does not overwrite the index after a failed read', async () => {
    await seed(['old']);
    state.indexReads = [
      async () => {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      },
    ];
    await expect(history.addEntry({ png, width: 1, height: 1 })).rejects.toThrow('EIO');
    expect(await indexIds()).toEqual(['old']);
    const added = await history.addEntry({ png, width: 1, height: 1 });
    expect(await indexIds()).toEqual([added.id, 'old']);
  });

  it('preserves an index that is not valid JSON', async () => {
    await fs.writeFile(indexFile(), '{oops');
    await expect(history.addEntry({ png, width: 1, height: 1 })).rejects.toThrow(SyntaxError);
    expect(await fs.readFile(indexFile(), 'utf8')).toBe('{oops');
  });

  it('keeps an entry until every holder has released it', async () => {
    state.historySize = 0;
    const entry = await history.addEntry({ png, width: 1, height: 1 }); // the delivery's hold
    history.retain(entry.id); // a preview's hold
    history.release(entry.id); // delivery done
    await settle();
    expect(existsSync(history.imagePath(entry.id))).toBe(true);
    expect(await indexIds()).toEqual([entry.id]);
    history.release(entry.id); // preview closed
    await settle();
    expect(existsSync(history.imagePath(entry.id))).toBe(false);
    expect(await indexIds()).toEqual([]);
  });

  it('clearing deletes exactly the entries it removed from the index', async () => {
    await seed(['held', 'free']);
    history.retain('held');
    // The hold goes while the cleared index is being written.
    state.afterPersist = () => {
      state.afterPersist = undefined;
      history.release('held');
    };
    await history.clearHistory();
    expect(await indexIds()).toEqual(['held']);
    expect(existsSync(history.imagePath('held'))).toBe(true);
    expect(existsSync(history.imagePath('free'))).toBe(false);
  });

  it('replaces an image and records where the edit was saved', async () => {
    await seed(['a']);
    const updated = await history.replaceImage('a', {
      png: new Uint8Array([1, 2, 3]),
      width: 2,
      height: 3,
      savedPath: '/tmp/a.png',
    });
    expect(updated).toMatchObject({ id: 'a', width: 2, height: 3, savedPath: '/tmp/a.png' });
    expect(updated?.updatedAt).toEqual(expect.any(Number));
    expect((await history.listEntries())[0]?.updatedAt).toBe(updated?.updatedAt);
    expect([...(await fs.readFile(history.imagePath('a')))]).toEqual([1, 2, 3]);
    expect((await fs.readdir(state.dir)).sort()).toEqual(['a.png', 'index.json']);
  });

  describe('editable entries', () => {
    const source = { bytes: new Uint8Array([9, 8, 7]).buffer, mime: 'image/png' as const };
    const doc = (annotations: unknown[], crop: unknown = null) => ({
      version: 1,
      unit: 1,
      annotations,
      crop,
    });
    const edit = (annotations: unknown[] = [{ id: 'a', kind: 'line' }]) => ({
      doc: doc(annotations),
      source: { ...source, width: 4, height: 3 },
    });

    it('keeps the original pixels and the document next to the rendered image', async () => {
      const entry = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      expect(existsSync(history.projectPath(entry.id))).toBe(true);
      const project = await history.readEditable(entry.id);
      expect(project?.doc).toEqual(doc([{ id: 'a', kind: 'line' }]));
      expect(project?.image).toEqual({ mime: 'image/png', width: 4, height: 3 });
      expect([...(project?.bytes ?? [])]).toEqual([9, 8, 7]);
      // The rendered image is still what copy, pin and export use.
      expect([...(await history.readImage(entry.id))]).toEqual([...png]);
    });

    it('re-saving replaces the document, and a plain save drops it', async () => {
      const entry = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      await history.replaceImage(entry.id, {
        png,
        width: 4,
        height: 3,
        edit: edit([{ id: 'b', kind: 'rect' }]),
      });
      expect((await history.readEditable(entry.id))?.doc).toEqual(doc([{ id: 'b', kind: 'rect' }]));
      await history.replaceImage(entry.id, { png, width: 4, height: 3 });
      expect(existsSync(history.projectPath(entry.id))).toBe(false);
      expect(await history.readEditable(entry.id)).toBeNull();
    });

    it('treats entries without a document, or with a malformed one, as plain images', async () => {
      await seed(['old', 'garbage', 'badcrop']);
      expect(await history.readEditable('old')).toBeNull();
      await fs.writeFile(history.projectPath('garbage'), 'not a project');
      expect(await history.readEditable('garbage')).toBeNull();
      const entry = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      const packed = await fs.readFile(history.projectPath(entry.id));
      const { packProject, unpackProject } = await import('../../src/shared/project');
      const project = unpackProject(packed);
      await fs.writeFile(
        history.projectPath('badcrop'),
        packProject({ ...project, doc: doc([], { x: 0, y: 0, width: 5, height: 3 }) }),
      );
      expect(await history.readEditable('badcrop')).toBeNull();
    });

    it('only accepts PNG sources with a well-formed document from windows', () => {
      expect(history.checkEditable(edit())).toEqual(edit());
      expect(history.checkEditable(undefined)).toBeUndefined();
      expect(
        history.checkEditable({ ...edit(), source: { ...edit().source, mime: 'image/jpeg' } }),
      ).toBeUndefined();
      expect(history.checkEditable({ ...edit(), doc: { version: 2 } })).toBeUndefined();
      expect(history.checkEditable({ ...edit(), doc: 'nope' })).toBeUndefined();
      for (const broken of [
        null,
        'edit',
        { doc: doc([]) },
        { doc: doc([]), source: null },
        { doc: doc([]), source: 'png' },
        { doc: doc([]), source: { ...edit().source, bytes: undefined } },
        { doc: doc([]), source: { ...edit().source, bytes: [1, 2, 3] } },
        { doc: doc([]), source: { ...edit().source, bytes: new ArrayBuffer(0) } },
        { doc: doc([]), source: { ...edit().source, width: 0 } },
        { doc: doc([]), source: { ...edit().source, height: 2.5 } },
        { doc: doc([]), source: { ...edit().source, width: '4' } },
      ]) {
        expect(history.checkEditable(broken)).toBeUndefined();
      }
    });

    it('delete, prune and clear remove the documents too', async () => {
      const a = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      const b = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      const c = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      for (const e of [a, b, c]) history.release(e.id);
      await history.removeEntry(a.id);
      expect(existsSync(history.projectPath(a.id))).toBe(false);
      state.historySize = 1;
      history.retain(c.id);
      history.release(c.id); // schedules a prune down to the newest entry
      await settle();
      expect(existsSync(history.projectPath(b.id))).toBe(false);
      expect(existsSync(history.projectPath(c.id))).toBe(true);
      await history.clearHistory();
      expect(await fs.readdir(state.dir)).toEqual(['index.json']);
    });

    it('a failed replace leaves the previous image, document and index in place', async () => {
      const entry = await history.addEntry({ png, width: 4, height: 3, edit: edit() });
      const index = await fs.readFile(indexFile(), 'utf8');
      state.failWrite = (path) => path.endsWith('.anyshot');
      await expect(
        history.replaceImage(entry.id, {
          png: new Uint8Array([1, 2, 3]),
          width: 8,
          height: 6,
          edit: edit([{ id: 'b', kind: 'rect' }]),
        }),
      ).rejects.toThrow('EIO');
      state.failWrite = undefined;
      expect([...(await history.readImage(entry.id))]).toEqual([...png]);
      expect((await history.readEditable(entry.id))?.doc).toEqual(doc([{ id: 'a', kind: 'line' }]));
      expect(await fs.readFile(indexFile(), 'utf8')).toBe(index);
      expect((await history.listEntries())[0]).toMatchObject({ width: 4, height: 3 });
    });

    it('a failed index write restores an overwritten image, thumbnail and document', async () => {
      const thumb = new Uint8Array([9, 9]);
      const entry = await history.addEntry({
        png,
        thumb: thumb.buffer,
        width: 4,
        height: 3,
        edit: edit(),
      });
      const index = await fs.readFile(indexFile(), 'utf8');
      state.failWrite = (path) => path.endsWith('index.json');
      await expect(
        history.replaceImage(entry.id, {
          png: new Uint8Array([1, 2, 3]),
          thumb: new Uint8Array([7]).buffer,
          width: 8,
          height: 6,
          edit: edit([{ id: 'b', kind: 'rect' }]),
        }),
      ).rejects.toThrow('EIO');
      state.failWrite = undefined;
      expect([...(await history.readImage(entry.id))]).toEqual([...png]);
      expect([...(await fs.readFile(history.thumbPath(entry.id)))]).toEqual([...thumb]);
      expect((await history.readEditable(entry.id))?.doc).toEqual(doc([{ id: 'a', kind: 'line' }]));
      expect(await fs.readFile(indexFile(), 'utf8')).toBe(index);
    });

    it('a failed index write removes files the entry did not have before', async () => {
      await seed(['plain']);
      state.failWrite = (path) => path.endsWith('index.json');
      await expect(
        history.replaceImage('plain', {
          png: new Uint8Array([1, 2, 3]),
          thumb: new Uint8Array([7]).buffer,
          width: 4,
          height: 3,
          edit: edit(),
        }),
      ).rejects.toThrow('EIO');
      expect([...(await history.readImage('plain'))]).toEqual([...png]);
      expect(existsSync(history.thumbPath('plain'))).toBe(false);
      expect(existsSync(history.projectPath('plain'))).toBe(false);
    });

    it('keeps failed queueEntry media recoverable in memory after all writes settle', async () => {
      state.failWrite = (path) => path.endsWith('.anyshot');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const entry = history.queueEntry({
          png,
          thumb: new Uint8Array([1, 2]).buffer,
          width: 4,
          height: 3,
          edit: edit(),
        });
        await history.flushHistory();
        expect(existsSync(history.imagePath(entry.id))).toBe(false);
        expect(existsSync(history.thumbPath(entry.id))).toBe(false);
        expect(existsSync(history.projectPath(entry.id))).toBe(false);
        expect((await history.listEntries()).map((e) => e.id)).toContain(entry.id);
        expect([...(await history.readImage(entry.id))]).toEqual([...png]);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
