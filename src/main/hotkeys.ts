import { globalShortcut, Notification } from 'electron';
import type { HotkeyFailure, HotkeyReport } from '../shared/ipc';
import {
  HOTKEY_ACTIONS,
  HOTKEY_LABELS,
  type HotkeyAction,
  type Settings,
} from '../shared/settings';

export type { HotkeyFailure, HotkeyReport } from '../shared/ipc';

let registered = new Map<string, HotkeyAction>();
let latestReport: HotkeyReport = { registered: [], unconfirmed: [], failed: [] };

function isWaylandPortal(): boolean {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'commandorcontrol',
  control: 'commandorcontrol',
  cmdorctrl: 'commandorcontrol',
  commandorcontrol: 'commandorcontrol',
  cmd: 'super',
  command: 'super',
  meta: 'super',
  super: 'super',
  option: 'alt',
  alt: 'alt',
  shift: 'shift',
};

function canonicalAccelerator(accelerator: string): string {
  const tokens = accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const key = tokens.pop() ?? '';
  const mods = [...new Set(tokens.map((t) => MODIFIER_ALIASES[t] ?? t))].sort();
  return [...mods, key].join('+');
}

export function getHotkeyReport(): HotkeyReport {
  return latestReport;
}

/** Re-registers all global shortcuts from settings. Event-driven: no polling. */
export function registerHotkeys(
  hotkeys: Settings['hotkeys'],
  run: (action: HotkeyAction) => void,
  options?: { portal?: boolean },
): HotkeyReport {
  globalShortcut.unregisterAll();
  registered = new Map();
  const portal = options?.portal ?? isWaylandPortal();
  const report: HotkeyReport = { registered: [], unconfirmed: [], failed: [] };
  for (const action of HOTKEY_ACTIONS) {
    const accelerator = hotkeys[action];
    if (!accelerator) continue;
    const canonical = canonicalAccelerator(accelerator);
    const conflictWith = registered.get(canonical);
    if (conflictWith) {
      report.failed.push({ action, accelerator, conflictWith });
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => run(action));
    } catch {
      ok = false;
    }
    if (ok) {
      registered.set(canonical, action);
      if (portal) report.unconfirmed.push(action);
      else report.registered.push(action);
    } else {
      report.failed.push({ action, accelerator });
    }
  }
  latestReport = report;
  if (report.failed.length > 0) {
    console.warn('[hotkeys] could not register', report.failed);
  }
  return report;
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
  registered.clear();
  latestReport = { registered: [], unconfirmed: [], failed: [] };
}

export function formatHotkeyFailureNotification(
  failed: HotkeyFailure[],
): { title: string; body: string } | null {
  const first = failed[0];
  if (!first) return null;
  if (failed.length === 1) {
    const label = HOTKEY_LABELS[first.action];
    return {
      title: 'Shortcut unavailable',
      body: first.conflictWith
        ? `${label} (${first.accelerator}) conflicts with ${HOTKEY_LABELS[first.conflictWith]}.`
        : `${label} (${first.accelerator}) could not be registered.`,
    };
  }
  const list = failed.map((f) => `${HOTKEY_LABELS[f.action]} (${f.accelerator})`).join(', ');
  return {
    title: 'Shortcuts unavailable',
    body: `${failed.length} shortcuts could not be registered: ${list}.`,
  };
}

export function notifyHotkeyFailures(failed: HotkeyFailure[]): void {
  const message = formatHotkeyFailureNotification(failed);
  if (message) new Notification(message).show();
}
