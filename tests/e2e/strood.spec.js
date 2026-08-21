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
  await expect(page.locator('#track-region')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Solo track' })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (localStorage.getItem('strudel_code')?.match(/mute: false/g) || []).length)).toBe(8);
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
  await expect(page.getByRole('button', { name: 'vocal voice' })).toBeVisible();
});

test('edits mastering controls in the song source', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Solo track' }).selectOption('bass');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain("const solo = 'bass'");

  await page.locator('.cm-smart-boolean[data-smart-name="mute"]').first().click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('mute: true');

  const master = page.locator('.cm-smart-number[data-smart-name="master"]');
  await expect(master).toBeVisible();
  const box = await master.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toMatch(/const master = (?!\.9\b)/);

  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// source remains editable\n');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('// source remains editable');

  await page.getByRole('combobox', { name: 'Visualiser placement' }).selectOption('dock');
  await expect(page.locator('body')).toHaveAttribute('data-visualizers', 'dock');
});

test('plays the source-mastered song through the protected output', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PLAYING' })).toBeVisible();
  await expect.poll(async () => await page.locator('#master-level').getAttribute('style') || '', { timeout: 15000 })
    .not.toContain('scaleX(0)');
  await expect(page.locator('#diagnostics')).toBeHidden();
});

test('uses keyboard-safe app dialogs instead of native prompts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save song' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Song name' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
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
  await page.keyboard.press('Meta+ArrowUp');
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

test('keeps transport, inline controls and editor usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Solo track' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true })).toBeVisible();
  const hasPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasPageOverflow).toBe(false);
});
