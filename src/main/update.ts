import { app, type BrowserWindow, Notification } from 'electron';
import {
  canSelfUpdate,
  checkNotice,
  lookForUpdate,
  type UpdateCheckResult,
  type UpdateOffer,
  type UpdateStatus,
} from '../shared/update';
import { handle } from './ipc';
import { isTest } from './paths';
import { getSettings } from './settings-store';
import { createWindow, send } from './windows';

/** The part of electron-updater the app uses; tests substitute a fake. */
export interface Updater {
  /** The newer release, or null when this is the latest. Rejects when offline. */
  check(): Promise<{ version: string; releaseNotes: string | null } | null>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /**
   * Quits, installs and restarts. Rejects if installing fails instead (an
   * AppImage in a folder the user can't write to): the app then keeps running.
   */
  install(): Promise<void>;
}

/**
 * electron-updater, loaded only in packaged builds. It reads app-update.yml
 * (the GitHub releases of this repo) and the release's latest.yml (Windows) or
 * latest-linux.yml. Nothing downloads until the user chooses Update.
 */
export async function electronUpdater(): Promise<Updater> {
  const module = await import('electron-updater');
  // CommonJS: autoUpdater is a getter on its exports, which ESM named imports don't see.
  const { autoUpdater } = module.default ?? module;
  if (!autoUpdater) throw new Error('electron-updater has no autoUpdater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      const notes = result.updateInfo.releaseNotes;
      return {
        version: result.updateInfo.version,
        releaseNotes:
          typeof notes === 'string' ? notes : (notes?.map((n) => n.note ?? '').join('\n') ?? null),
      };
    },
    async download(onProgress) {
      const listener = (progress: { percent: number }) => onProgress(progress.percent);
      autoUpdater.on('download-progress', listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off('download-progress', listener);
      }
    },
    install() {
      return new Promise<void>((_resolve, reject) => {
        // Install failures are emitted, not thrown; on success the app quits.
        autoUpdater.once('error', reject);
        // Silent: the installer already ran once with the user's choices; then restart.
        autoUpdater.quitAndInstall(true, true);
      });
    },
  };
}

let updater: Updater | null = null;
let offer: UpdateOffer | null = null;
let status: UpdateStatus = { state: 'idle' };
let win: BrowserWindow | null = null;
let checking: Promise<UpdateCheckResult> | null = null;
let installRequested = false;

/** The updater: a test's fake, or electron-updater in packaged builds; null in development. */
async function loadUpdater(): Promise<Updater | null> {
  if (!updater && app.isPackaged) updater = await electronUpdater();
  return updater;
}

/** Tests drive the update window with a fake updater. */
export function useUpdater(next: Updater): void {
  updater = next;
}

/**
 * Looks for a newer release once, a little after startup. Only packaged builds
 * check (not `electron .` in development or the e2e suite), and only when the
 * user allows it; offline or failed checks are logged and otherwise ignored.
 */
export async function checkAtStartup(): Promise<void> {
  if (!app.isPackaged || isTest || !getSettings().general.checkForUpdates) return;
  await checkNow();
}

/**
 * Checks once (at startup, or when the user asks from the tray or Settings ▸
 * About). A newer release opens the update window; checks started while one
 * runs share its result, so the window opens once.
 */
export function checkNow(): Promise<UpdateCheckResult> {
  checking ??= runCheck().finally(() => {
    checking = null;
  });
  return checking;
}

async function runCheck(): Promise<UpdateCheckResult> {
  // Asking again mid-download would replace electron-updater's release info under it.
  if (offer && (status.state === 'downloading' || status.state === 'installing')) {
    showUpdate(offer);
    return { state: 'available', offer };
  }
  let current: Updater | null;
  try {
    current = await loadUpdater();
  } catch (error) {
    console.warn('[update] updater unavailable', error);
    return { state: 'error', message: 'The updater could not be loaded.' };
  }
  if (!current) {
    return {
      state: 'unavailable',
      message: 'This is a development build. Installed builds can check for updates.',
    };
  }
  const result = await lookForUpdate({
    current: app.getVersion(),
    canInstall: canSelfUpdate(process.platform, process.env),
    check: () => current.check(),
  });
  if (result.state === 'available') showUpdate(result.offer);
  if (result.state === 'error') console.warn(`[update] update check failed: ${result.message}`);
  return result;
}

/** The tray has no page to show the result on: anything but a new release is a notification. */
export async function checkFromTray(): Promise<void> {
  const notice = checkNotice(await checkNow());
  if (notice) new Notification(notice).show();
}

/** Shows the small update window for an offer (or brings it forward). */
export function showUpdate(next: UpdateOffer): void {
  // A download under way keeps going, even if its window was closed: the window
  // comes back showing it, so Update can't start a second one.
  const busy = status.state === 'downloading' || status.state === 'installing';
  if (!busy) {
    offer = next;
    status = { state: 'idle' };
  }
  if (win && !win.isDestroyed()) {
    // Reloading picks up a newer offer and clears an earlier error.
    if (!busy) win.webContents.reload();
    win.show();
    win.focus();
    return;
  }
  const created = createWindow('update', {
    width: 440,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    title: 'anyshot update',
    backgroundColor: '#18181b',
  });
  win = created;
  created.once('ready-to-show', () => created.show());
  created.once('closed', () => {
    if (win === created) win = null;
  });
}

function setStatus(next: UpdateStatus): void {
  status = next;
  send(win, 'update:status', next);
}

handle('update:init', () => {
  if (!offer) throw new Error('No update to show');
  return { offer, status };
});

handle('update:install', async () => {
  if (installRequested || status.state === 'downloading' || status.state === 'installing') return;
  installRequested = true;
  try {
    const accepted = offer?.version;
    // A running check can leave another release in the updater. Let it finish; if it
    // found another version, the window now shows that one and waits for a new click.
    await checking;
    if (!offer?.canInstall || !updater || offer.version !== accepted) return;
    const current = updater;
    setStatus({ state: 'downloading', percent: 0 });
    await current.download((percent) =>
      setStatus({ state: 'downloading', percent: Math.max(0, Math.min(100, percent)) }),
    );
    setStatus({ state: 'installing' });
    await current.install();
  } catch (error) {
    setStatus({
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    installRequested = false;
  }
});
