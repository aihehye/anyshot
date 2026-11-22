import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ElectronApplication, expect, test } from '@playwright/test';
import type { UpdateOffer } from '../../src/shared/update';
import {
  clickClosing,
  dispatch,
  type Launched,
  launch,
  pageOf,
  verifyAndClose,
  windowKinds,
} from './harness';

let ctx: Launched;

test.beforeEach(async () => {
  ctx = await launch();
  // Links open in the browser; record them instead.
  await ctx.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { __opened: opened });
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
});

test.afterEach(async () => {
  await verifyAndClose(ctx);
});

const offer = (patch: Partial<UpdateOffer> = {}): UpdateOffer => ({
  version: '0.3.0',
  current: '0.1.2',
  notes: ['Scroll capture keeps track while scrolling slowly', 'Text styles'],
  releaseUrl: 'https://github.com/mgamergo/anyshot/releases/tag/v0.3.0',
  canInstall: true,
  ...patch,
});

async function showOffer(
  app: ElectronApplication,
  o: UpdateOffer,
  plan: { fail?: string; installFail?: string; holdMs?: number } = {},
) {
  await app.evaluate((_e, [o, plan]) => globalThis.__anyshot?.offerUpdate(o, plan), [
    o,
    plan,
  ] as const);
  return pageOf(app, 'update');
}

const opened = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);

test('the app does not check for updates when it runs unpackaged (development, e2e)', async () => {
  expect(await ctx.app.evaluate(() => globalThis.__anyshot?.startupCheck())).toBe(0);
  expect(await windowKinds(ctx.app)).toEqual([]);
});

test('electron-updater loads in the built main process', async () => {
  // Development and the e2e suite never check, so load it explicitly: packaged builds do.
  expect(await ctx.app.evaluate(() => globalThis.__anyshot?.loadUpdater())).toBe(true);
});

test('the update window shows the version and notes, and Update downloads and installs', async () => {
  const page = await showOffer(ctx.app, offer());
  await expect(page.getByTestId('update-title')).toHaveText('anyshot 0.3.0 is available');
  await expect(page.getByText('You have 0.1.2.')).toBeVisible();
  await expect(page.getByTestId('update-notes').getByRole('listitem')).toHaveText([
    'Scroll capture keeps track while scrolling slowly',
    'Text styles',
  ]);
  await page.getByRole('button', { name: 'Release notes' }).click();
  await expect.poll(() => opened(ctx.app)).toEqual([offer().releaseUrl]);

  await page.getByTestId('update-install').click();
  await expect(page.getByTestId('update-progress')).toContainText('Downloading… 30 %');
  await expect(page.getByTestId('update-later')).toBeDisabled();
  await expect(page.getByTestId('update-progress')).toContainText('restarts in a moment');
  // The one download finishes and installs once.
  await expect
    .poll(() => ctx.app.evaluate(() => globalThis.__anyshot?.updateInstalls), { timeout: 10_000 })
    .toBe(1);
});

test('a failed download says why and can be tried again; Later closes the window', async () => {
  const page = await showOffer(ctx.app, offer(), { fail: 'net::ERR_CONNECTION_RESET' });
  await page.getByTestId('update-install').click();
  await expect(page.getByTestId('update-error')).toContainText('net::ERR_CONNECTION_RESET');
  await expect(page.getByTestId('update-install')).toHaveText('Try again');
  await expect(page.getByTestId('update-later')).toBeEnabled();
  expect(await ctx.app.evaluate(() => globalThis.__anyshot?.updateInstalls)).toBe(0);
  await clickClosing(page.getByTestId('update-later'));
  await expect.poll(() => windowKinds(ctx.app)).toEqual([]);
});

test('an install that fails after the download says why, and the app keeps running', async () => {
  const page = await showOffer(ctx.app, offer(), { installFail: 'EACCES: permission denied' });
  await page.getByTestId('update-install').click();
  await expect(page.getByTestId('update-error')).toContainText('EACCES: permission denied');
  await expect(page.getByTestId('update-install')).toHaveText('Try again');
  await expect(page.getByTestId('update-later')).toBeEnabled();
  expect(await ctx.app.evaluate(() => globalThis.__anyshot?.updateInstalls)).toBe(1);
});

test('a .deb install links to the release instead of updating itself', async () => {
  const page = await showOffer(ctx.app, offer({ canInstall: false }));
  await expect(page.getByTestId('update-manual')).toContainText('.deb');
  await expect(page.getByTestId('update-install')).toHaveCount(0);
  await clickClosing(page.getByTestId('update-download'));
  await expect.poll(() => windowKinds(ctx.app)).toEqual([]);
  expect(await opened(ctx.app)).toEqual([offer().releaseUrl]);
});

test('update checks can be turned off in Settings', async () => {
  await dispatch(ctx.app, 'settings');
  const page = await pageOf(ctx.app, 'settings');
  const toggle = page.getByTestId('check-updates');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect
    .poll(async () => {
      const saved = JSON.parse(await readFile(join(ctx.userData, 'settings.json'), 'utf8'));
      return saved.general?.checkForUpdates;
    })
    .toBe(false);
});

const fakeUpdates = (app: ElectronApplication, plan: { version?: string; fail?: string }) =>
  app.evaluate((_e, plan) => globalThis.__anyshot?.fakeUpdates(plan), plan);

/** Records notifications instead of showing them. */
async function recordNotices(app: ElectronApplication) {
  await app.evaluate(({ Notification }) => {
    const notices: { title: string; body: string }[] = [];
    Object.assign(globalThis, { __notices: notices });
    Notification.prototype.show = function (this: Electron.Notification) {
      notices.push({ title: this.title, body: this.body });
    };
  });
}
const notices = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __notices?: unknown[] }).__notices ?? []);

const clickTray = (app: ElectronApplication, label: string) =>
  app.evaluate(({ Menu }, label) => {
    const item = Menu.getApplicationMenu()?.items.find((i) => i.label === label);
    if (!item) throw new Error(`no tray item ${label}`);
    item.click();
  }, label);

test('Check for updates in the tray opens the update window for a newer release', async () => {
  await fakeUpdates(ctx.app, { version: '9.0.0' });
  await clickTray(ctx.app, 'Check for updates…');
  const page = await pageOf(ctx.app, 'update');
  await expect(page.getByTestId('update-title')).toHaveText('anyshot 9.0.0 is available');
});

test('Check for updates in the tray says when this is the latest version, or why it failed', async () => {
  await recordNotices(ctx.app);
  const version = await ctx.app.evaluate(({ app }) => app.getVersion());
  await fakeUpdates(ctx.app, {});
  await clickTray(ctx.app, 'Check for updates…');
  await expect
    .poll(() => notices(ctx.app))
    .toEqual([
      { title: 'anyshot is up to date', body: `You have the latest version, ${version}.` },
    ]);

  await fakeUpdates(ctx.app, { fail: 'net::ERR_INTERNET_DISCONNECTED' });
  await clickTray(ctx.app, 'Check for updates…');
  await expect.poll(async () => (await notices(ctx.app)).length).toBe(2);
  expect((await notices(ctx.app))[1]).toEqual({
    title: 'Could not check for updates',
    body: 'net::ERR_INTERNET_DISCONNECTED',
  });
  expect(await windowKinds(ctx.app)).toEqual([]);
});

test('Settings ▸ About shows version details and checks for updates', async () => {
  await dispatch(ctx.app, 'settings');
  const page = await pageOf(ctx.app, 'settings');
  await page.getByTestId('tab-about').click();
  const version = await ctx.app.evaluate(({ app }) => app.getVersion());
  await expect(page.getByTestId('about-version')).toHaveText(`Version ${version}`);
  const details = page.getByTestId('about-details');
  for (const name of ['Install', 'Electron', 'Chromium', 'Node.js', 'V8', 'OS']) {
    await expect(details.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(details).toContainText('Development build');

  const status = page.getByTestId('about-update-status');
  const check = page.getByTestId('about-check-updates');
  // Unpackaged with no updater: nothing to check against.
  await check.click();
  await expect(status).toHaveText(
    'This is a development build. Installed builds can check for updates.',
  );

  await fakeUpdates(ctx.app, {});
  await check.click();
  await expect(status).toHaveText('You have the latest version.');

  await fakeUpdates(ctx.app, { version: '9.0.0' });
  await check.click();
  await expect(status).toHaveText('anyshot 9.0.0 is available.');
  await expect((await pageOf(ctx.app, 'update')).getByTestId('update-title')).toHaveText(
    'anyshot 9.0.0 is available',
  );

  await page.getByTestId('about-copy').click();
  await expect(page.getByTestId('about-copy')).toHaveText('Copied');
  const copied = await ctx.app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toContain(`Version: ${version}`);
  expect(copied).toContain('Electron: ');
});

test('checking again after closing the window during a download shows that download', async () => {
  const page = await showOffer(ctx.app, offer(), { holdMs: 3000 });
  await page.getByTestId('update-install').click();
  await expect(page.getByTestId('update-progress')).toContainText('Downloading… 30 %');
  // The title bar's close button, not Later.
  await ctx.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes('/update/')) w.close();
    }
  });
  await expect.poll(() => windowKinds(ctx.app)).toEqual([]);

  // The updater isn't asked while it downloads; asking would fail here and say so.
  await recordNotices(ctx.app);
  await fakeUpdates(ctx.app, { fail: 'asked during a download' });
  await clickTray(ctx.app, 'Check for updates…');
  const again = await pageOf(ctx.app, 'update');
  await expect(again.getByTestId('update-title')).toHaveText('anyshot 0.3.0 is available');
  await expect(again.getByTestId('update-progress')).toContainText('Downloading… 30 %');
  await expect(again.getByTestId('update-install')).toBeDisabled();
  // The one download finishes and installs once.
  await expect
    .poll(() => ctx.app.evaluate(() => globalThis.__anyshot?.updateInstalls), { timeout: 10_000 })
    .toBe(1);
  expect(await notices(ctx.app)).toEqual([]);
});
