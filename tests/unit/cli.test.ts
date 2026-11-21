import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { handleSecondInstance, parseCli } from '../../src/main/cli';

describe('command line', () => {
  it('maps flags to actions and ignores the rest', () => {
    expect(parseCli(['/usr/bin/anyshot', '--capture', '--no-sandbox', '--record'])).toEqual([
      { action: 'captureArea' },
      { action: 'recordArea' },
    ]);
  });

  it('parses --open with a path in both forms', () => {
    expect(parseCli(['--open', '/tmp/a.png'])).toEqual([
      { action: 'openImage', file: '/tmp/a.png' },
    ]);
    expect(parseCli(['--open=/tmp/b.png'])).toEqual([{ action: 'openImage', file: '/tmp/b.png' }]);
    expect(parseCli(['--open', '--capture'])).toEqual([{ action: 'captureArea' }]);
  });

  it('opens a bare image or project path, as "Open with" passes it', () => {
    expect(
      parseCli(['C:\\Program Files\\anyshot\\anyshot.exe', 'C:\\Users\\me\\Shot 1.PNG']),
    ).toEqual([{ action: 'openImage', file: 'C:\\Users\\me\\Shot 1.PNG' }]);
    expect(parseCli(['/opt/anyshot/anyshot', '/home/me/a.webp', '/home/me/b.anyshot'])).toEqual([
      { action: 'openImage', file: '/home/me/a.webp' },
      { action: 'openImage', file: '/home/me/b.anyshot' },
    ]);
  });

  it('opens file:// URLs from a desktop entry (%U)', () => {
    // A path of this platform (file:///C:/… on Windows), with a space escaped as %20.
    const file = resolve('My shot.jpg');
    const url = pathToFileURL(file).href;
    expect(url).toContain('My%20shot.jpg');
    expect(parseCli(['/opt/anyshot/anyshot', url])).toEqual([{ action: 'openImage', file }]);
  });

  it('ignores the executable, switches and other bare arguments', () => {
    expect(parseCli(['/tmp/odd-name.png'])).toEqual([]);
    expect(
      parseCli(['/usr/bin/electron', '.', 'notes.txt', '--flag=x.png', 'file://%%bad.png']),
    ).toEqual([]);
  });

  it('resolves relative files against the requesting instance directory', () => {
    const caller = resolve('caller');
    const absolute = resolve('b.png');
    expect(parseCli(['--open', 'shot.png', `--open=${absolute}`], caller)).toEqual([
      { action: 'openImage', file: join(caller, 'shot.png') },
      { action: 'openImage', file: absolute },
    ]);
    expect(parseCli(['anyshot', 'shot.png'], caller)).toEqual([
      { action: 'openImage', file: join(caller, 'shot.png') },
    ]);
  });

  describe('second-instance handling', () => {
    it('opens settings on a bare re-launch when no app window is open', () => {
      const dispatch = vi.fn();
      const focusExistingWindow = vi.fn(() => false);

      handleSecondInstance(
        ['C:\\Program Files\\anyshot\\anyshot.exe'],
        undefined,
        dispatch,
        focusExistingWindow,
      );

      expect(focusExistingWindow).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith('settings');
    });

    it('focuses an existing app window on a bare re-launch without opening settings', () => {
      const dispatch = vi.fn();
      const focusExistingWindow = vi.fn(() => true);

      handleSecondInstance(
        ['C:\\Program Files\\anyshot\\anyshot.exe', '--allow-file-access-from-files'],
        undefined,
        dispatch,
        focusExistingWindow,
      );

      expect(focusExistingWindow).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('dispatches CLI flags and file paths without focusing or opening settings', () => {
      const dispatch = vi.fn();
      const focusExistingWindow = vi.fn(() => true);
      const caller = resolve('caller');

      handleSecondInstance(
        ['anyshot', '--capture-ocr', 'shot.png'],
        caller,
        dispatch,
        focusExistingWindow,
      );

      expect(focusExistingWindow).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenNthCalledWith(1, 'captureOcr', undefined);
      expect(dispatch).toHaveBeenNthCalledWith(2, 'openImage', join(caller, 'shot.png'));
    });
  });
});
