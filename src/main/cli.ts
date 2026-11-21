import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_EXTENSION } from '../shared/project';
import type { HotkeyAction } from '../shared/settings';

export type AppAction =
  | HotkeyAction
  | 'stopRecording'
  | 'settings'
  | 'openImage'
  | 'openClipboard'
  | 'quit';

export interface CliCommand {
  action: AppAction;
  file?: string;
}

const FLAGS: Record<string, AppAction> = {
  '--capture': 'captureArea',
  '--capture-screen': 'captureScreen',
  '--capture-ocr': 'captureOcr',
  '--quick-capture': 'quickCapture',
  '--capture-last': 'captureLastArea',
  '--scroll-capture': 'scrollCapture',
  '--record': 'recordArea',
  '--record-gif': 'recordGif',
  '--stop-recording': 'stopRecording',
  '--history': 'history',
  '--settings': 'settings',
  '--pin-clipboard': 'pinClipboard',
  '--open-clipboard': 'openClipboard',
};

/**
 * Turns command-line arguments into app actions. This is how Linux users bind
 * `anyshot --capture` in their desktop's keyboard settings when global
 * shortcuts aren't available (most Wayland sessions).
 */
export function parseCli(argv: readonly string[], workingDirectory?: string): CliCommand[] {
  const commands: CliCommand[] = [];
  const openFile = (file: string): CliCommand => ({
    action: 'openImage',
    file: file && workingDirectory ? resolve(workingDirectory, file) : file,
  });
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const action = FLAGS[arg];
    // The first argument is the executable itself.
    const bare = i > 0 ? openableFile(arg) : null;
    if (action) commands.push({ action });
    else if (arg === '--open') {
      const file = argv[i + 1];
      if (file && !file.startsWith('--')) {
        commands.push(openFile(file));
        i++;
      }
    } else if (arg.startsWith('--open=')) {
      commands.push(openFile(arg.slice('--open='.length)));
    } else if (bare) commands.push(openFile(bare));
  }
  return commands;
}

/**
 * Handles a second-instance launch: dispatches any parsed CLI commands, or on
 * a bare re-launch focuses an existing app window or opens Settings.
 */
export function handleSecondInstance(
  argv: readonly string[],
  workingDirectory: string | undefined,
  dispatch: (action: AppAction, file?: string) => void,
  focusExistingWindow: () => boolean,
): void {
  const commands = parseCli(argv, workingDirectory);
  if (commands.length > 0) {
    for (const command of commands) dispatch(command.action, command.file);
    return;
  }
  if (!focusExistingWindow()) dispatch('settings');
}

/**
 * Files anyshot opens when they are passed bare, as "Open with" does
 * (`anyshot.exe "C:\shot.png"` on Windows, `anyshot %U` from a Linux desktop entry).
 */
export const OPENABLE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', PROJECT_EXTENSION];
const OPENABLE = new RegExp(`\\.(${OPENABLE_EXTENSIONS.join('|')})$`, 'i');

/** A bare argument that names an image or project: a path or a file:// URL. */
function openableFile(arg: string): string | null {
  if (arg.startsWith('-')) return null;
  let path = arg;
  if (/^file:/i.test(arg)) {
    try {
      path = fileURLToPath(arg);
    } catch {
      return null;
    }
  }
  return OPENABLE.test(path) ? path : null;
}

export const CLI_FLAGS = Object.keys(FLAGS);
