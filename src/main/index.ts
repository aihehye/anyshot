import { app, Menu } from 'electron';
import type { Settings } from '../shared/settings';
import { runAction, setCaptureDelay } from './actions';
import { onAppState } from './app-state';
import { type AppAction, handleSecondInstance, parseCli } from './cli';
import { notifyHotkeyFailures, registerHotkeys, unregisterHotkeys } from './hotkeys';
import { registerIpc } from './ipc-handlers';
import { isTest } from './paths';
import { registerAppScheme } from './protocol';
import { getSettings, loadSettings, onSettingsChanged } from './settings-store';
import { createTray, trayTemplate, updateTray } from './tray';
import { broadcast, focusExisting } from './windows';

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

const isWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
if (isWayland) {
  // Lets globalShortcut go through the desktop's GlobalShortcuts portal.
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}
registerAppScheme();

function dispatch(action: AppAction, file?: string): void {
  runAction(action, file).catch((error) => console.error(`[action] ${action} failed`, error));
}

function refreshTray(settings: Settings): void {
  const template = trayTemplate(settings, dispatch, setCaptureDelay);
  const menu = updateTray(template);
  // Tests drive the same menu the tray shows.
  if (isTest) Menu.setApplicationMenu(menu);
}

function applyHotkeys(hotkeys: Settings['hotkeys']): void {
  const report = registerHotkeys(hotkeys, (action) => dispatch(action));
  broadcast('hotkeys:changed', report);
  if (report.failed.length > 0 && !isTest) notifyHotkeyFailures(report.failed);
}

app.on('second-instance', (_event, argv, workingDirectory) => {
  handleSecondInstance(argv, workingDirectory, dispatch, () =>
    (['settings', 'history', 'editor'] as const).some(focusExisting),
  );
});

// Stay in the tray when the last window closes.
app.on('window-all-closed', () => {});

app.on('will-quit', () => unregisterHotkeys());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  const settings = await loadSettings();
  createTray();
  refreshTray(settings);
  applyHotkeys(settings.hotkeys);
  onSettingsChanged((next, prev) => {
    refreshTray(next);
    if (next.capture.instantCapture !== prev.capture.instantCapture) {
      void import('./capture/session').then((m) =>
        next.capture.instantCapture ? m.prewarm() : m.dropWarm(),
      );
    }
    if (next.general.launchAtLogin !== prev.general.launchAtLogin) {
      void import('./login-item')
        .then((m) => m.applyLaunchAtLogin(next.general.launchAtLogin))
        .catch((error) => console.error('[login-item] could not update autostart', error));
    }
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) {
      applyHotkeys(next.hotkeys);
    }
  });
  onAppState(() => refreshTray(getSettings()));
  if (isTest) (await import('./test-hooks')).installTestHooks(dispatch);
  if (settings.capture.instantCapture) (await import('./capture/session')).prewarm();
  // Look for an update once startup has settled; it never blocks or fails startup.
  setTimeout(() => {
    import('./update')
      .then((m) => m.checkAtStartup())
      .catch((error) => console.warn('[update] check skipped', error));
  }, 5000);
  for (const command of parseCli(process.argv)) dispatch(command.action, command.file);
});
