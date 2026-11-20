import { type BrowserWindow, shell } from 'electron';
import type { ToolChoices } from '../shared/settings';
import { copyText } from './clipboard';
import { releaseFrame } from './frames';
import { getHotkeyReport } from './hotkeys';
import { handle } from './ipc';
import { getSettings, onSettingsChanged, patchSettings } from './settings-store';
import { broadcast } from './windows';

/** Handlers shared by all windows. Feature modules register their own on import. */
export function registerIpc(): void {
  handle('settings:get', () => getSettings());
  handle('settings:patch', (patch) => patchSettings(patch));
  handle('hotkeys:status', () => getHotkeyReport());
  registerToolChoices();
  handle('window:close', (_req, { win }) => win.close());
  handle('window:set-size', ({ width, height }, { win }) => {
    win.setContentSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  });
  handle('frame:release', (id) => releaseFrame(id));
  handle('clipboard:text', (text) => copyText(text));
  // Registered here, not by the capture session: editors opened from history,
  // files or the clipboard deliver too, without any capture having run.
  handle('capture:deliver', async (request, { kind, win }) => {
    // The overlay has already encoded everything it needs; close it right away.
    if (kind === 'overlay') (await import('./capture/session')).endCapture(win);
    // Editors hold the entry their edits go to, which changes on a first save or Save as copy.
    const holdEntry = kind === 'editor' ? (await import('./editor')).holdEntry : undefined;
    return (await import('./deliver')).deliver(request, holdEntry && ((id) => holdEntry(win, id)));
  });
  handle('shell:open-url', async (url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
  onSettingsChanged((next) => broadcast('settings:changed', next));
}

function registerToolChoices(): void {
  const observed = new WeakSet<BrowserWindow>();
  let pending: Partial<ToolChoices> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    clearTimeout(timer);
    if (Object.keys(pending).length === 0) return;
    const tools = pending;
    pending = {};
    void patchSettings({ tools }).catch((error) =>
      console.error('[settings] could not remember tool choices', error),
    );
  }

  // Main receives the choices before an overlay is destroyed. Disk writes can
  // still be debounced even when the renderer that sent them is already gone.
  handle('settings:remember-tools', (tools, { win }) => {
    Object.assign(pending, tools);
    if (!observed.has(win)) {
      observed.add(win);
      win.once('closed', flush);
    }
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });
}
