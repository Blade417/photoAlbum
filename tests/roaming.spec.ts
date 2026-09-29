import { expect, test, type Locator, type Page } from './fixtures';
import { createDemoManifest } from '../scripts/media-manifest.mjs';
import { DEFAULT_CONTENT } from '../shared/album-content.mjs';

// Use bundled media and isolated text fixtures without changing the owner's files.
test.beforeEach(async ({ page }) => {
  await page.route('**/media-manifest.json', route => route.fulfill({ json: createDemoManifest() }));
  await page.route('**/__album/content', route => route.fulfill({ json: { content: DEFAULT_CONTENT, writable: true } }));
  await page.route('**/album-content.json', route => route.fulfill({ json: DEFAULT_CONTENT }));
});

const scene = (page: Page) => page.locator('.galaxy-scene canvas');
const vector = async (canvas: Locator, attribute: string): Promise<number[]> => JSON.parse((await canvas.getAttribute(attribute))!);
const displacement = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
const distance = async (page: Page) => Number(await scene(page).getAttribute('data-camera-distance'));

async function openGalaxy(page: Page) {
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-card-count', '99');
  await expect(page.locator('.loading-indicator')).toHaveCount(0);
}

async function focusFirstMemory(page: Page) {
  await page.getByRole('button', { name: '查看照片：山的另一边', exact: true }).click();
  await page.getByRole('button', { name: '在星空中靠近', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开启自动漫游', exact: true })).toBeVisible();
  await expect.poll(async () => displacement([1.5, 0.7, 16], await vector(scene(page), 'data-camera-target'))).toBeLessThan(0.2);
  await expect.poll(() => distance(page)).toBeLessThan(11);
  await expect(scene(page)).toHaveAttribute('data-camera-transition', 'none');
}

async function expectBroadOrbit(page: Page) {
  await expect.poll(async () => displacement([0, 0, 0], await vector(scene(page), 'data-camera-target'))).toBeLessThan(0.05);
  await expect.poll(() => distance(page)).toBeGreaterThan(40);
  await expect(scene(page)).toHaveAttribute('data-camera-transition', 'none');
  await expect(scene(page)).toHaveAttribute('data-auto-rotate', 'true');
}

test('automatic roaming leaves a focused memory smoothly and visibly travels around the galaxy', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGalaxy(page);
  await focusFirstMemory(page);
  const closePosition = await vector(scene(page), 'data-camera-position');
  const closeTarget = await vector(scene(page), 'data-camera-target');
  await page.screenshot({ path: testInfo.outputPath('focused-memory.png') });
  await page.getByRole('button', { name: '开启自动漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-camera-transition', 'roaming');
  const samples = await scene(page).evaluate(async canvas => {
    const readings: { distance: number; target: number[] }[] = [];
    const until = performance.now() + 1900;
    while (performance.now() < until) {
      readings.push({ distance: Number(canvas.getAttribute('data-camera-distance')), target: JSON.parse(canvas.getAttribute('data-camera-target')!) });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return readings;
  });
  expect(samples.filter(sample => sample.distance > 12 && sample.distance < 40).length).toBeGreaterThanOrEqual(2);
  expect(samples.some(sample => displacement(closeTarget, sample.target) > 1 && displacement([0, 0, 0], sample.target) > 1)).toBe(true);
  await expectBroadOrbit(page);
  await page.screenshot({ path: testInfo.outputPath('wide-automatic-roaming.png') });
  expect(displacement(closePosition, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(15);
  const orbitPosition = await vector(scene(page), 'data-camera-position');
  await expect.poll(async () => displacement(orbitPosition, await vector(scene(page), 'data-camera-position')), { timeout: 3000, intervals: [200] }).toBeGreaterThan(1);
  await page.getByRole('button', { name: '暂停自动漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-auto-rotate', 'false');
  const stopped = await vector(scene(page), 'data-camera-position');
  await page.waitForTimeout(1800);
  expect(displacement(stopped, await vector(scene(page), 'data-camera-position'))).toBeLessThan(0.2);
  expect(errors).toEqual([]);
});

test('pausing during the return cancels it, and Space can resume or pause roaming', async ({ page }) => {
  await openGalaxy(page);
  await focusFirstMemory(page);
  await scene(page).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '暂停自动漫游', exact: true })).toBeVisible();
  await expect.poll(() => distance(page), { intervals: [75] }).toBeGreaterThan(15);
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: '开启自动漫游', exact: true })).toBeVisible();
  await expect(scene(page)).toHaveAttribute('data-camera-transition', 'none');
  const stoppedPosition = await vector(scene(page), 'data-camera-position');
  const stoppedTarget = await vector(scene(page), 'data-camera-target');
  expect(displacement([0, 0, 0], stoppedTarget)).toBeGreaterThan(1);
  await page.waitForTimeout(2200);
  expect(displacement(stoppedPosition, await vector(scene(page), 'data-camera-position'))).toBeLessThan(0.2);
  expect(displacement(stoppedTarget, await vector(scene(page), 'data-camera-target'))).toBeLessThan(0.2);
  await page.keyboard.press('Space');
  await expectBroadOrbit(page);
});

test('dragging interrupts the return so automatic roaming does not recenter later', async ({ page }) => {
  await openGalaxy(page);
  await focusFirstMemory(page);
  await page.getByRole('button', { name: '开启自动漫游', exact: true }).click();
  await expect.poll(() => distance(page), { intervals: [75] }).toBeGreaterThan(15);
  await page.mouse.move(950, 420);
  await page.mouse.down();
  await expect(scene(page)).toHaveAttribute('data-camera-transition', 'none');
  const interruptedTarget = await vector(scene(page), 'data-camera-target');
  const beforeDrag = await vector(scene(page), 'data-camera-position');
  expect(displacement([0, 0, 0], interruptedTarget)).toBeGreaterThan(1);
  await page.mouse.move(1120, 480, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => displacement(beforeDrag, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(2);
  await page.waitForTimeout(2200);
  expect(displacement(interruptedTarget, await vector(scene(page), 'data-camera-target'))).toBeLessThan(0.2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('roaming after a random arrival widens the view, including with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGalaxy(page);
  await page.evaluate(() => { Math.random = () => 0.5; });
  await page.getByRole('button', { name: '开始漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
  const arrivedTarget = await vector(scene(page), 'data-camera-target');
  const arrivedDistance = await distance(page);
  await page.getByRole('button', { name: '开启自动漫游', exact: true }).click();
  await expectBroadOrbit(page);
  expect(await distance(page)).toBeGreaterThan(arrivedDistance + 10);
  expect(displacement(arrivedTarget, await vector(scene(page), 'data-camera-target'))).toBeGreaterThan(10);
  await expect(page.getByRole('region', { name: '已抵达一段回忆' })).toHaveCount(0);
});

test.describe('phone automatic roaming', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  test('starting after a close-up restores a wide orbit that fits the portrait screen', async ({ page }) => {
    await openGalaxy(page);
    await page.locator('.strip-thumbnail').first().tap();
    await page.getByRole('button', { name: '在星空中靠近', exact: true }).tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => displacement([1.5, 0.7, 16], await vector(scene(page), 'data-camera-target'))).toBeLessThan(0.2);
    await expect(scene(page)).toHaveAttribute('data-camera-transition', 'none');
    const closeDistance = await distance(page);
    await page.getByRole('button', { name: '开启自动漫游', exact: true }).tap();
    await expectBroadOrbit(page);
    expect(await distance(page)).toBeGreaterThan(60);
    expect(await distance(page)).toBeGreaterThan(closeDistance + 20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
