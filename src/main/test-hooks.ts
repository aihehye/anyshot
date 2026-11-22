import { app } from 'electron';
import type { UpdateOffer } from '../shared/update';
import type { AppAction } from './cli';
import { frameCount } from './frames';
import { getSettings, patchSettings } from './settings-store';
import { allWindows } from './windows';

export interface TestHooks {
  dispatch(action: AppAction, file?: string): void;
  windows(): { kind: string; visible: boolean; bounds: Electron.Rectangle }[];
  processTypes(): string[];
  frameCount(): number;
  settings(): unknown;
  patch(patch: unknown): Promise<unknown>;
  timings: Record<string, number[]>;
  /**
   * Shows the update window with a fake updater: its download reports 30 %,
   * waits (`holdMs`, default 300), then fails or "installs".
   */
  offerUpdate(
    offer: UpdateOffer,
    plan?: { fail?: string; installFail?: string; holdMs?: number },
  ): Promise<void>;
  /** Runs the startup check against a fake updater and returns how often it was asked. */
  startupCheck(): Promise<number>;
  /** Later checks ask a fake updater that finds `version` (none: up to date) or fails. */
  fakeUpdates(plan: { version?: string; fail?: string }): Promise<void>;
  updateInstalls: number;
  /** Loads electron-updater as packaged builds do, without checking: whether it worked. */
  loadUpdater(): Promise<boolean>;
}

declare global {
  var __anyshot: TestHooks | undefined;
}

/** Exposed only when ANYSHOT_TEST=1, for Playwright's `app.evaluate`. */
export function installTestHooks(dispatch: (action: AppAction, file?: string) => void): void {
  globalThis.__anyshot = {
    dispatch,
    windows: () =>
      allWindows()
        .filter(({ win }) => !win.isDestroyed())
        .map(({ kind, win }) => ({ kind, visible: win.isVisible(), bounds: win.getBounds() })),
    processTypes: () => app.getAppMetrics().map((m) => m.type),
    frameCount,
    settings: getSettings,
    patch: (patch) => patchSettings(patch as never),
    timings: {},
    updateInstalls: 0,
    async offerUpdate(offer, plan = {}) {
      const update = await import('./update');
      update.useUpdater({
        check: async () => null,
        async download(onProgress) {
          onProgress(30);
          await new Promise((r) => setTimeout(r, plan.holdMs ?? 300));
          if (plan.fail) throw new Error(plan.fail);
          onProgress(100);
        },
        install: async () => {
          const hooks = globalThis.__anyshot;
          if (hooks) hooks.updateInstalls++;
          if (plan.installFail) throw new Error(plan.installFail);
        },
      });
      update.showUpdate(offer);
    },
    async loadUpdater() {
      const update = await import('./update');
      const real = await update.electronUpdater();
      return typeof real.check === 'function';
    },
    async fakeUpdates(plan) {
      (await import('./update')).useUpdater({
        check: async () => {
          if (plan.fail) throw new Error(plan.fail);
          return plan.version ? { version: plan.version, releaseNotes: '* A new thing' } : null;
        },
        download: async () => {},
        install: async () => {},
      });
    },
    async startupCheck() {
      const update = await import('./update');
      let checks = 0;
      update.useUpdater({
        check: async () => {
          checks++;
          return { version: '99.0.0', releaseNotes: null };
        },
        download: async () => {},
        install: async () => {},
      });
      await update.checkAtStartup();
      return checks;
    },
  };
}

export function recordTiming(name: string, ms: number): void {
  const hooks = globalThis.__anyshot;
  if (!hooks) return;
  const list = hooks.timings[name] ?? [];
  list.push(ms);
  hooks.timings[name] = list;
}
