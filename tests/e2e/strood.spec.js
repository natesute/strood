const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

test('exposes the core live-coding workflow without hidden shortcuts', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Strood');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Patch' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Song code' })).toBeVisible();
  await expect(page.locator('.track-strip')).toHaveCount(8);
});

test('opens the searchable song browser and patch module palette', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('dialog', { name: 'Saved songs' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Filter saved songs' })).toBeFocused();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Patch' }).click();
  await expect(page.getByRole('dialog', { name: 'Patch studio' })).toBeVisible();
  await page.getByRole('button', { name: 'add module' }).click();
  await expect(page.getByRole('dialog', { name: 'Add synth module' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Find a synth module' })).toBeFocused();
});

test('uses linked editor views for multi-column mode', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+2');
  await expect(page.locator('.editor-panel')).toHaveCount(2);
  const secondEditor = page.getByRole('textbox', { name: 'Song code, column 2' });
  await expect(secondEditor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// linked view check\n');
  await secondEditor.click();
  await page.keyboard.press('Control+Home');
  await expect(secondEditor).toContainText('// linked view check');
});

test('has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();

  const studioAudit = await new AxeBuilder({ page }).analyze();
  expect(studioAudit.violations).toEqual([]);

  await page.getByRole('button', { name: 'Patch', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Patch studio' })).toBeVisible();
  const patchAudit = await new AxeBuilder({ page }).analyze();
  expect(patchAudit.violations).toEqual([]);
});

test('versions song saves and rejects a stale overwrite', async ({ request }) => {
  const name = `strood api test ${Date.now()}`;
  const encodedName = encodeURIComponent(name);
  const songPath = path.join(process.cwd(), 'songs', `${name}.strudel`);
  const historyPath = path.join(
    process.cwd(),
    'songs',
    '.history',
    crypto.createHash('sha1').update(name).digest('hex').slice(0, 16),
  );

  try {
    const first = await request.put(`/api/songs/${encodedName}`, { data: 'first version' });
    expect(first.ok()).toBeTruthy();
    const firstVersion = first.headers().etag;

    const second = await request.put(`/api/songs/${encodedName}`, {
      data: 'second version',
      headers: { 'If-Match': firstVersion },
    });
    expect(second.ok()).toBeTruthy();

    const conflict = await request.put(`/api/songs/${encodedName}`, {
      data: 'stale overwrite',
      headers: { 'If-Match': firstVersion },
    });
    expect(conflict.status()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: 'version_conflict' });

    const history = await request.get(`/api/songs/${encodedName}/history`);
    expect(await history.json()).toHaveLength(1);
  } finally {
    await fs.rm(songPath, { force: true });
    await fs.rm(historyPath, { recursive: true, force: true });
  }
});

test('keeps transport, tracks and editor usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.locator('.track-strip').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true })).toBeVisible();
  const hasPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasPageOverflow).toBe(false);
});
