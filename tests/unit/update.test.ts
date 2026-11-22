import { describe, expect, it } from 'vitest';
import { mergeUpdateMetadata } from '../../scripts/merge-update-metadata';
import {
  canSelfUpdate,
  checkNotice,
  installKind,
  lookForUpdate,
  osName,
  releaseUrl,
  shortNotes,
} from '../../src/shared/update';

/** Release notes as GitHub renders them: the download table, then the generated changes. */
const GITHUB_HTML = `<h2>Downloads</h2>
<table><thead><tr><th>File</th><th>For</th></tr></thead><tbody>
<tr><td><code>anyshot-Setup-0.2.0-x64.exe</code></td><td>Windows 10 and 11 on Intel or AMD (x64)</td></tr>
</tbody></table>
<p>The Windows installers are not code-signed yet, so SmartScreen may warn.</p>
<h2>What's Changed</h2>
<ul>
<li>Scroll capture: keep track while scrolling slowly, at any scaling by <a href="https://github.com/u">@u</a> in <a href="https://github.com/mgamergo/anyshot/pull/7">https://github.com/mgamergo/anyshot/pull/7</a></li>
<li>Close popovers on a click outside them &amp; on Esc by <a href="https://github.com/u">@u</a> in <a href="https://github.com/mgamergo/anyshot/pull/8">#8</a></li>
</ul>
<p><strong>Full Changelog</strong>: <a href="https://github.com/mgamergo/anyshot/compare/v0.1.2...v0.2.0">v0.1.2...v0.2.0</a></p>`;

describe('update notes', () => {
  it('keeps the changes from GitHub release notes, without credits or the download table', () => {
    expect(shortNotes(GITHUB_HTML)).toEqual([
      'Scroll capture: keep track while scrolling slowly, at any scaling',
      'Close popovers on a click outside them & on Esc',
    ]);
  });

  it('reads Markdown lists too, and shortens long lists', () => {
    const md = Array.from(
      { length: 8 },
      (_, i) => `* Change [${i + 1}](https://x) by @u in #${i}`,
    ).join('\n');
    expect(shortNotes(md, 3)).toEqual(['Change 1', 'Change 2', 'Change 3', '…and 5 more']);
    expect(shortNotes(null)).toEqual([]);
    expect(shortNotes('No list here.')).toEqual([]);
  });
});

describe('self-update', () => {
  it('is possible for the Windows installer and an AppImage, not for a .deb', () => {
    expect(canSelfUpdate('win32', {})).toBe(true);
    expect(canSelfUpdate('linux', { APPIMAGE: '/home/u/anyshot.AppImage' })).toBe(true);
    expect(canSelfUpdate('linux', {})).toBe(false);
    expect(canSelfUpdate('darwin', {})).toBe(false);
  });

  it('links to the release of the offered version', () => {
    expect(releaseUrl('0.2.0')).toBe('https://github.com/mgamergo/anyshot/releases/tag/v0.2.0');
  });
});

const yml = (arch: string, version = '0.2.0') => `version: ${version}
files:
  - url: anyshot-Setup-${version}-${arch}.exe
    sha512: ${arch}-hash==
    size: ${arch === 'x64' ? 100 : 90}
path: anyshot-Setup-${version}-${arch}.exe
sha512: ${arch}-hash==
releaseDate: '2026-11-20T12:00:00.000Z'
`;

describe('update check', () => {
  const lookup = { current: '0.1.2', canInstall: true };

  it('reports a newer release, the latest version, or why it failed', async () => {
    const found = await lookForUpdate({
      ...lookup,
      check: async () => ({ version: '0.2.0', releaseNotes: GITHUB_HTML }),
    });
    expect(found).toMatchObject({
      state: 'available',
      offer: {
        version: '0.2.0',
        current: '0.1.2',
        canInstall: true,
        releaseUrl: releaseUrl('0.2.0'),
      },
    });
    expect(found.state === 'available' && found.offer.notes).toHaveLength(2);
    expect(await lookForUpdate({ ...lookup, check: async () => null })).toEqual({
      state: 'latest',
      current: '0.1.2',
    });
    // A feed that lists the running version is no update either.
    expect(
      await lookForUpdate({
        ...lookup,
        check: async () => ({ version: '0.1.2', releaseNotes: null }),
      }),
    ).toEqual({ state: 'latest', current: '0.1.2' });
    expect(
      await lookForUpdate({
        ...lookup,
        check: async () => {
          throw new Error('HttpError: 403 rate limit exceeded');
        },
      }),
    ).toEqual({ state: 'error', message: 'HttpError: 403 rate limit exceeded' });
  });

  it('notifies about everything but a new release, which opens the update window', () => {
    expect(checkNotice({ state: 'latest', current: '0.3.0' })).toEqual({
      title: 'anyshot is up to date',
      body: 'You have the latest version, 0.3.0.',
    });
    expect(checkNotice({ state: 'error', message: 'offline' })).toEqual({
      title: 'Could not check for updates',
      body: 'offline',
    });
    expect(checkNotice({ state: 'unavailable', message: 'dev' })?.title).toBe(
      'Updates unavailable',
    );
    const offer = {
      version: '0.4.0',
      current: '0.3.0',
      notes: [],
      releaseUrl: releaseUrl('0.4.0'),
      canInstall: true,
    };
    expect(checkNotice({ state: 'available', offer })).toBeNull();
  });
});

describe('version details', () => {
  it('names the install', () => {
    expect(installKind('win32', {}, true)).toBe('Windows installer');
    expect(installKind('linux', { APPIMAGE: '/a.AppImage' }, true)).toBe('AppImage');
    expect(installKind('linux', {}, true)).toBe('Debian package');
    expect(installKind('win32', {}, false)).toBe('Development build');
  });

  it('names Windows 11 although it reports 10.0', () => {
    expect(osName('win32', '10.0.26300', 'x64')).toBe('Windows 11 (10.0.26300, x64)');
    expect(osName('win32', '10.0.19045', 'arm64')).toBe('Windows 10 (10.0.19045, arm64)');
    expect(osName('linux', '6.8.0-45-generic', 'x64')).toBe('Linux 6.8.0-45-generic (x64)');
  });
});

describe('update metadata for both Windows installers', () => {
  it('lists both installers and keeps the first one as the default', () => {
    expect(mergeUpdateMetadata(yml('x64'), yml('arm64'))).toBe(`version: 0.2.0
files:
  - url: anyshot-Setup-0.2.0-x64.exe
    sha512: x64-hash==
    size: 100
  - url: anyshot-Setup-0.2.0-arm64.exe
    sha512: arm64-hash==
    size: 90
path: anyshot-Setup-0.2.0-x64.exe
sha512: x64-hash==
releaseDate: '2026-11-20T12:00:00.000Z'
`);
  });

  it('lists a file once, and refuses different versions or missing lists', () => {
    expect(mergeUpdateMetadata(yml('x64'), yml('x64'))).toBe(yml('x64'));
    expect(() => mergeUpdateMetadata(yml('x64'), yml('arm64', '0.2.1'))).toThrow(/Versions differ/);
    expect(() => mergeUpdateMetadata('version: 1.0.0\n', yml('x64'))).toThrow(/no files/);
  });

  it('accepts Windows line endings', () => {
    const merged = mergeUpdateMetadata(yml('x64').replace(/\n/g, '\r\n'), yml('arm64'));
    expect(merged).toContain('-arm64.exe');
    expect(merged).not.toContain('\r');
  });
});
