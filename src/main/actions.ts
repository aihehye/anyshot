import { app } from 'electron';
import type { CaptureMode } from '../shared/ipc';
import type { HotkeyAction } from '../shared/settings';
import { appState, setAppState } from './app-state';
import type { AppAction } from './cli';

const CAPTURE_MODES: Partial<Record<AppAction, CaptureMode>> = {
  captureArea: 'area',
  captureScreen: 'screen',
  captureOcr: 'ocr',
  quickCapture: 'quick',
  captureLastArea: 'last',
  scrollCapture: 'scroll',
  recordArea: 'record',
  recordGif: 'gif',
};

export function isCaptureAction(action: AppAction): action is HotkeyAction {
  return action in CAPTURE_MODES;
}

/**
 * The single entry point for tray items, global shortcuts, command-line flags
 * and tests. Feature modules are imported on first use to keep idle memory low.
 */
export async function runAction(action: AppAction, file?: string): Promise<void> {
  const mode = CAPTURE_MODES[action];
  if (mode) {
    if (appState.recording && (mode === 'record' || mode === 'gif')) {
      return runAction('stopRecording');
    }
    const { startCapture } = await import('./capture/session');
    return startCapture(mode);
  }
  switch (action) {
    case 'stopRecording':
      return (await import('./recording')).stopRecording();
    case 'togglePauseRecording':
      return (await import('./recording')).togglePauseRecording();
    case 'history':
      return (await import('./history-window')).openHistory();
    case 'settings':
      return (await import('./settings-window')).openSettings();
    case 'checkForUpdates':
      return (await import('./update')).checkFromTray();
    case 'openImage':
      await (await import('./editor')).openImage(file);
      return;
    case 'openClipboard':
      return (await import('./editor')).openClipboard();
    case 'pinClipboard':
      return (await import('./pins')).pinClipboard();
    case 'quit':
      app.quit();
      return;
  }
}

export function setCaptureDelay(seconds: number): void {
  setAppState({ delaySeconds: seconds });
}
