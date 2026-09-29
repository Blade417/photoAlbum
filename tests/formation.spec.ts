import { expect, test, type Page } from '@playwright/test';
import { createDemoManifest } from '../scripts/media-manifest.mjs';
import { DEFAULT_CONTENT } from '../shared/album-content.mjs';

// Uses the plain Playwright test: every page starts in a fresh tab without the "formed" mark.
test.beforeEach(async ({ page }) => {
  await page.route('**/media-manifest.json', route => route.fulfill({ json: createDemoManifest() }));
  await page.route('**/__album/content', route => route.fulfill({ json: { content: DEFAULT_CONTENT, writable: true } }));
  await page.route('**/album-content.json', route => route.fulfill({ json: DEFAULT_CONTENT }));
});

const scene = (page: Page) => page.locator('.galaxy-scene canvas');
const dock = (page: Page) => page.getByRole('region', { name: '回忆导航' });

test('the album opens as a sphere that bursts into the universe on click, once per tab', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-formation', 'sphere');
  await expect(page.locator('.scene-caption')).toContainText('轻触它，让回忆散开');
  await expect(dock(page)).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('sphere.png') });
  // A click on the sphere bursts it rather than opening the memory under the pointer.
  await scene(page).click({ position: { x: 720, y: 500 } });
  await expect(scene(page)).toHaveAttribute('data-formation', 'forming');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: testInfo.outputPath('burst.png') });
  await expect(scene(page)).toHaveAttribute('data-formation', 'galaxy', { timeout: 6000 });
  await expect(dock(page)).toBeVisible();
  await expect(page.locator('.dock-caption')).toContainText('个瞬间，正在闪耀');
  await expect(page.locator('.scene-caption')).toHaveCount(0);
  await page.reload();
  await expect(scene(page)).toHaveAttribute('data-formation', 'galaxy');
  await expect(dock(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('starting a journey from the sphere bursts it first, then flies to a memory', async ({ page }) => {
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-formation', 'sphere');
  await page.getByRole('button', { name: '开始漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-formation', 'forming');
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'flying', { timeout: 6000 });
  await expect(scene(page)).toHaveAttribute('data-formation', 'galaxy');
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived', { timeout: 10_000 });
  await expect(page.getByRole('region', { name: '已抵达一段回忆' })).toBeVisible();
});

test('approaching a memory from the overview forms the universe immediately', async ({ page }) => {
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-formation', 'sphere');
  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await page.locator('.gallery-card').first().click();
  await page.getByRole('button', { name: '在星空中靠近' }).click();
  await expect(scene(page)).toHaveAttribute('data-formation', 'galaxy');
  await expect.poll(async () => JSON.parse((await scene(page).getAttribute('data-camera-target'))!)[2]).toBeGreaterThan(15);
});

test('reduced motion opens the universe directly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-formation', 'galaxy');
  await expect(dock(page)).toBeVisible();
});
