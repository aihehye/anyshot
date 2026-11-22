/**
 * Update logic that doesn't need Electron: what an update offer looks like,
 * whether this install can update itself, the short notes shown to the user,
 * and the update checks with their dependencies injected.
 */

export const RELEASES_URL = 'https://github.com/mgamergo/anyshot/releases';

export interface UpdateOffer {
  version: string;
  current: string;
  /** A few lines from the release notes. */
  notes: string[];
  releaseUrl: string;
  /** The install can replace itself (NSIS, AppImage); otherwise the user downloads the release (.deb). */
  canInstall: boolean;
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'downloading'; percent: number }
  | { state: 'installing' }
  | { state: 'error'; message: string };

/** What a check started by the user (tray, Settings ▸ About) found. */
export type UpdateCheckResult =
  | { state: 'available'; offer: UpdateOffer }
  | { state: 'latest'; current: string }
  /** This build can't update (development); nothing was checked. */
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string };

/**
 * Whether this install can download and apply an update by itself: the NSIS
 * installer on Windows and an AppImage (which sets APPIMAGE) on Linux can; a
 * .deb belongs to the package manager.
 */
export function canSelfUpdate(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform === 'win32') return true;
  return platform === 'linux' && !!env.APPIMAGE;
}

/** How anyshot was installed, as shown in Settings ▸ About. */
export function installKind(
  platform: string,
  env: Record<string, string | undefined>,
  packaged: boolean,
): string {
  if (!packaged) return 'Development build';
  if (platform === 'win32') return 'Windows installer';
  if (platform === 'linux') return env.APPIMAGE ? 'AppImage' : 'Debian package';
  return 'Packaged';
}

/**
 * A readable OS name. Windows 11 still reports itself as 10.0, so builds from
 * 22000 on are named 11.
 */
export function osName(platform: string, release: string, arch: string): string {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2]);
    return `Windows ${build >= 22000 ? 11 : 10} (${release}, ${arch})`;
  }
  const name = platform === 'linux' ? 'Linux' : platform;
  return `${name} ${release} (${arch})`;
}

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#39|[a-z]+);/g, (m, name: string) => ENTITIES[name] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A few lines worth showing from release notes (HTML from GitHub, or Markdown):
 * the list items, i.e. the changes, without the download table, links or
 * "by @user in #12" credits.
 */
export function shortNotes(notes: string | null | undefined, max = 5): string[] {
  if (!notes) return [];
  const html = /<li[\s>]/i.test(notes);
  const items = html
    ? [...notes.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => plain(m[1] ?? ''))
    : notes
        .split('\n')
        .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1] ?? '')
        .map((line) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, ''));
  const lines = items
    .map((line) => line.replace(/\s+by @\S+ in \S+$/i, '').replace(/\s+in https?:\/\/\S+$/i, ''))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^full changelog/i.test(line));
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`…and ${lines.length - max} more`);
  return shown;
}

/** What a check needs; injected so it can be tested without Electron or a network. */
export interface UpdateLookup {
  current: string;
  canInstall: boolean;
  /** The newer release, or null when this is the latest. Rejects when offline. */
  check(): Promise<{ version: string; releaseNotes: string | null } | null>;
}

/** Asks for a newer release once; never throws (offline, rate limits, no release). */
export async function lookForUpdate(deps: UpdateLookup): Promise<UpdateCheckResult> {
  let found: Awaited<ReturnType<UpdateLookup['check']>>;
  try {
    found = await deps.check();
  } catch (error) {
    return { state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (!found || found.version === deps.current) return { state: 'latest', current: deps.current };
  return {
    state: 'available',
    offer: {
      version: found.version,
      current: deps.current,
      notes: shortNotes(found.releaseNotes),
      releaseUrl: releaseUrl(found.version),
      canInstall: deps.canInstall,
    },
  };
}

/** What a notification says about a check; null when the update window shows the result. */
export function checkNotice(result: UpdateCheckResult): { title: string; body: string } | null {
  switch (result.state) {
    case 'available':
      return null;
    case 'latest':
      return {
        title: 'anyshot is up to date',
        body: `You have the latest version, ${result.current}.`,
      };
    case 'unavailable':
      return { title: 'Updates unavailable', body: result.message };
    case 'error':
      return { title: 'Could not check for updates', body: result.message };
  }
}
