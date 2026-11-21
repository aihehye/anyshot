import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

const registerMock = vi.fn<(accel: string, cb: () => void) => boolean>();
const unregisterAllMock = vi.fn();
const notificationShowMock = vi.fn();
const notificationCtorMock = vi.fn(function (
  this: { show: typeof notificationShowMock },
  _opts: { title: string; body: string },
) {
  this.show = notificationShowMock;
});

vi.mock('electron', () => ({
  globalShortcut: {
    register: registerMock,
    unregisterAll: unregisterAllMock,
  },
  Notification: notificationCtorMock,
}));

const {
  formatHotkeyFailureNotification,
  getHotkeyReport,
  notifyHotkeyFailures,
  registerHotkeys,
  unregisterHotkeys,
} = await import('../../src/main/hotkeys');

describe('hotkeys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerMock.mockReturnValue(true);
    unregisterHotkeys();
  });

  it('registers configured accelerators and updates getHotkeyReport', () => {
    const report = registerHotkeys(DEFAULT_SETTINGS.hotkeys, () => {}, { portal: false });
    expect(report.failed).toEqual([]);
    expect(report.unconfirmed).toEqual([]);
    expect(report.registered).toEqual([
      'captureArea',
      'captureScreen',
      'captureOcr',
      'recordArea',
      'history',
    ]);
    expect(getHotkeyReport()).toEqual(report);
  });

  it('marks Wayland portal submissions as unconfirmed while still detecting conflicts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hotkeys = {
        ...DEFAULT_SETTINGS.hotkeys,
        captureArea: 'Ctrl+Shift+X',
        captureScreen: 'Shift+CommandOrControl+x',
      };
      const report = registerHotkeys(hotkeys, () => {}, { portal: true });
      expect(report.registered).toEqual([]);
      expect(report.unconfirmed).toEqual(['captureArea', 'captureOcr', 'recordArea', 'history']);
      expect(report.failed).toEqual([
        {
          action: 'captureScreen',
          accelerator: 'Shift+CommandOrControl+x',
          conflictWith: 'captureArea',
        },
      ]);
      expect(getHotkeyReport()).toEqual(report);
    } finally {
      warn.mockRestore();
    }
  });

  it('records globalShortcut.register failures and thrown errors', () => {
    registerMock.mockImplementation((accel) => {
      if (accel === 'Alt+Shift+X') return false;
      if (accel === 'Alt+Shift+F') throw new Error('boom');
      return true;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = registerHotkeys(DEFAULT_SETTINGS.hotkeys, () => {}, { portal: false });
      expect(report.failed).toEqual([
        { action: 'captureArea', accelerator: 'Alt+Shift+X' },
        { action: 'captureScreen', accelerator: 'Alt+Shift+F' },
      ]);
      expect(report.registered).toEqual(['captureOcr', 'recordArea', 'history']);
      expect(getHotkeyReport()).toEqual(report);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('records duplicate accelerators as conflicts without re-registering', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hotkeys = {
        ...DEFAULT_SETTINGS.hotkeys,
        captureArea: 'Ctrl+Shift+X',
        captureScreen: 'Shift+CommandOrControl+x',
      };
      const report = registerHotkeys(hotkeys, () => {}, { portal: false });
      expect(report.registered).toContain('captureArea');
      expect(report.registered).not.toContain('captureScreen');
      expect(report.failed).toEqual([
        {
          action: 'captureScreen',
          accelerator: 'Shift+CommandOrControl+x',
          conflictWith: 'captureArea',
        },
      ]);
      expect(registerMock).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it('clears the latest report on unregisterHotkeys', () => {
    registerMock.mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      registerHotkeys(DEFAULT_SETTINGS.hotkeys, () => {});
      expect(getHotkeyReport().failed.length).toBeGreaterThan(0);
      unregisterHotkeys();
      expect(getHotkeyReport()).toEqual({ registered: [], unconfirmed: [], failed: [] });
    } finally {
      warn.mockRestore();
    }
  });

  it('formats and shows notifications for failed or conflicting shortcuts', () => {
    expect(formatHotkeyFailureNotification([])).toBeNull();
    notifyHotkeyFailures([]);
    expect(notificationCtorMock).not.toHaveBeenCalled();

    const singleFailure = formatHotkeyFailureNotification([
      { action: 'captureArea', accelerator: 'Alt+Shift+X' },
    ]);
    expect(singleFailure).toEqual({
      title: 'Shortcut unavailable',
      body: 'Capture area (Alt+Shift+X) could not be registered.',
    });

    const singleConflict = formatHotkeyFailureNotification([
      { action: 'captureScreen', accelerator: 'Alt+Shift+X', conflictWith: 'captureArea' },
    ]);
    expect(singleConflict).toEqual({
      title: 'Shortcut unavailable',
      body: 'Capture screen (Alt+Shift+X) conflicts with Capture area.',
    });

    const multiple = formatHotkeyFailureNotification([
      { action: 'captureArea', accelerator: 'Alt+Shift+X' },
      { action: 'captureScreen', accelerator: 'Alt+Shift+X', conflictWith: 'captureArea' },
    ]);
    expect(multiple).toEqual({
      title: 'Shortcuts unavailable',
      body: '2 shortcuts could not be registered: Capture area (Alt+Shift+X), Capture screen (Alt+Shift+X).',
    });

    notifyHotkeyFailures([{ action: 'captureArea', accelerator: 'Alt+Shift+X' }]);
    expect(notificationCtorMock).toHaveBeenCalledWith(singleFailure);
    expect(notificationShowMock).toHaveBeenCalledOnce();
  });
});
