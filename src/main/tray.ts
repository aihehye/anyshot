import { join } from 'node:path';
import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import type { HotkeyAction, Settings } from '../shared/settings';
import { appState } from './app-state';
import type { AppAction } from './cli';
import { paths } from './paths';

let tray: Tray | null = null;

export function createTray(): Tray {
  tray = new Tray(icon(false));
  tray.setToolTip('anyshot');
  return tray;
}

function icon(recording: boolean) {
  return nativeImage.createFromPath(
    join(paths.resources, recording ? 'tray-recording.png' : 'tray.png'),
  );
}

/** Builds the tray menu template. Rebuilt only when settings or recording state change. */
export function trayTemplate(
  settings: Settings,
  run: (action: AppAction) => void,
  setDelay: (seconds: number) => void,
): MenuItemConstructorOptions[] {
  const item = (label: string, action: AppAction): MenuItemConstructorOptions => {
    const accelerator = settings.hotkeys[action as HotkeyAction];
    return {
      label,
      click: () => run(action),
      ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    };
  };
  const delays = [0, 3, 5, 10, 30];
  return [
    ...(appState.recording
      ? [
          item('Stop recording', 'stopRecording'),
          item(
            appState.recordingPaused ? 'Resume recording' : 'Pause recording',
            'togglePauseRecording',
          ),
          { type: 'separator' } as const,
        ]
      : []),
    item('Capture area', 'captureArea'),
    item('Capture screen', 'captureScreen'),
    item('Capture text (OCR)', 'captureOcr'),
    item('Capture last area', 'captureLastArea'),
    item('Scroll capture', 'scrollCapture'),
    {
      label: 'Capture delay',
      submenu: delays.map((seconds) => ({
        label: seconds === 0 ? 'None' : `${seconds} seconds`,
        type: 'radio' as const,
        checked: appState.delaySeconds === seconds,
        click: () => setDelay(seconds),
      })),
    },
    { type: 'separator' },
    item('Record area', 'recordArea'),
    item('Record GIF', 'recordGif'),
    { type: 'separator' },
    item('History', 'history'),
    item('Open image…', 'openImage'),
    item('Open from clipboard', 'openClipboard'),
    item('Pin from clipboard', 'pinClipboard'),
    { type: 'separator' },
    item('Settings…', 'settings'),
    item('Check for updates…', 'checkForUpdates'),
    item('Quit anyshot', 'quit'),
  ];
}

export function updateTray(template: MenuItemConstructorOptions[]): Menu {
  const menu = Menu.buildFromTemplate(template);
  if (tray) {
    tray.setContextMenu(menu);
    tray.setImage(icon(appState.recording));
    tray.setToolTip(
      appState.recordingPaused
        ? 'anyshot — recording paused'
        : appState.recording
          ? 'anyshot — recording'
          : 'anyshot',
    );
  }
  return menu;
}
