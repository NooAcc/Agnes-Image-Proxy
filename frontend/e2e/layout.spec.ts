import { expect, test } from '@playwright/test';
import { login, gotoSection, listGallery } from './helpers';

test('generation uses the available wide content area without oversized side gutters', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1273 });
  await login(page);
  await gotoSection(page, 'generate');
  const main = await page.locator('.main').boundingBox();
  const layout = await page.locator('.generation-layout').boundingBox();
  expect(main).not.toBeNull();
  expect(layout).not.toBeNull();
  expect(layout!.x - main!.x).toBeLessThanOrEqual(32);
  expect(main!.x + main!.width - layout!.x - layout!.width).toBeLessThanOrEqual(32);
  await gotoSection(page, 'overview');
  expect((await page.locator('.content').boundingBox())!.width).toBeLessThanOrEqual(1240);
});

test('gallery detail actions have two paired rows and leave more width for the prompt', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await gotoSection(page, 'gallery');
  const item = (await listGallery(page)).find(image => image.archived)!;
  await page.locator(`.gallery-card[data-id="${item.id}"] .gallery-open`).click();
  const dialog = page.locator('[data-role="gallery-dialog"]');
  await expect(dialog).toBeVisible();
  const copy = (await dialog.getByRole('button', { name: '复制提示词', exact: true }).boundingBox())!;
  const reference = (await dialog.getByRole('button', { name: '作为参考图', exact: true }).boundingBox())!;
  const download = (await dialog.getByRole('link', { name: '下载', exact: true }).boundingBox())!;
  const remove = (await dialog.getByRole('button', { name: '删除', exact: true }).boundingBox())!;
  expect(Math.abs(copy.y - reference.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(download.y - remove.y)).toBeLessThanOrEqual(1);
  expect(download.y).toBeGreaterThan(copy.y + copy.height);
  const actions = (await dialog.locator('.lightbox-actions').boundingBox())!;
  const info = (await dialog.locator('.lightbox-info').boundingBox())!;
  expect(actions.width).toBeLessThan(240);
  expect(info.width).toBeGreaterThan(actions.width * 2);
});
