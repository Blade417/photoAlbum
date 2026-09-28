import { expect, test, type Locator, type Page } from '@playwright/test';
import { createDemoManifest } from '../scripts/media-manifest.mjs';
import { DEFAULT_CONTENT } from '../shared/album-content.mjs';

// Fixture requests isolate acceptance from the owner's media and saved text.
test.beforeEach(async ({ page }) => {
  await page.route('**/media-manifest.json', route => route.fulfill({ json: createDemoManifest() }));
  await page.route('**/__album/content', route => route.fulfill({ json: { content: DEFAULT_CONTENT, writable: true } }));
  await page.route('**/album-content.json', route => route.fulfill({ json: DEFAULT_CONTENT }));
});

const scene = (page: Page) => page.locator('.galaxy-scene canvas');
const arrival = (page: Page) => page.getByRole('region', { name: '已抵达第一段回忆' });
const vector = async (canvas: Locator, attribute: string): Promise<number[]> => JSON.parse((await canvas.getAttribute(attribute))!);
const displacement = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));

async function openGalaxy(page: Page) {
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-card-count', '99');
  await expect(page.locator('.loading-indicator')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始漫游', exact: true })).toBeEnabled();
}

async function startJourney(page: Page) {
  await page.getByRole('button', { name: '开始漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'flying');
  await expect(page.locator('.journey-indicator')).toBeVisible();
}

async function expectFullControls(page: Page) {
  await expect(page.locator('main')).not.toHaveClass(/is-journey/);
  await expect(page.locator('.journey-indicator')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拉近', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重置视角', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '回忆导航', exact: true })).toBeVisible();
}

// Observe beyond the entire original flight: a cancelled animation must never
// briefly report arrival or retake ownership after another view is closed.
async function expectNoDelayedArrival(page: Page) {
  const states = await scene(page).evaluate(async canvas => {
    const seen = [canvas.getAttribute('data-journey-state')];
    const observer = new MutationObserver(() => seen.push(canvas.getAttribute('data-journey-state')));
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-journey-state'] });
    await new Promise(resolve => setTimeout(resolve, 3300));
    observer.disconnect();
    return seen;
  });
  expect(states).not.toContain('arrived');
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'cancelled');
  await expect(arrival(page)).toHaveCount(0);
}

test('start flies through intermediate camera positions, arrives, and opens the first memory', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGalaxy(page);
  const initialPosition = await vector(scene(page), 'data-camera-position');
  const initialTarget = await vector(scene(page), 'data-camera-target');
  await startJourney(page);
  await expect(scene(page)).toBeFocused();
  await expect.poll(async () => Number(await scene(page).getAttribute('data-journey-progress'))).toBeGreaterThan(0.15);
  await page.screenshot({ path: testInfo.outputPath('desktop-journey-flying.png') });
  const samples = await scene(page).evaluate(async canvas => {
    const readings: { progress: number; position: number[]; target: number[] }[] = [];
    const end = performance.now() + 1100;
    while (performance.now() < end) {
      readings.push({
        progress: Number(canvas.getAttribute('data-journey-progress')),
        position: JSON.parse(canvas.getAttribute('data-camera-position')!),
        target: JSON.parse(canvas.getAttribute('data-camera-target')!),
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return readings;
  });
  expect(samples.filter(sample => sample.progress > 0 && sample.progress < 1).length).toBeGreaterThanOrEqual(3);
  expect(new Set(samples.map(sample => JSON.stringify(sample.position))).size).toBeGreaterThanOrEqual(3);
  expect(new Set(samples.map(sample => JSON.stringify(sample.target))).size).toBeGreaterThanOrEqual(3);
  expect(samples.every((sample, index) => index === 0 || sample.progress >= samples[index - 1].progress)).toBe(true);
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
  await expect(scene(page)).toHaveAttribute('data-journey-progress', '1');
  expect(displacement(initialPosition, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(5);
  expect(displacement(initialTarget, await vector(scene(page), 'data-camera-target'))).toBeGreaterThan(5);
  await expect(arrival(page)).toBeVisible();
  await expect(arrival(page)).toContainText('山的另一边');
  await page.screenshot({ path: testInfo.outputPath('desktop-journey-arrived.png') });
  await arrival(page).getByRole('button', { name: '打开这段回忆' }).click();
  await expect(page.getByRole('dialog', { name: '山的另一边' })).toBeVisible();
  await expect.poll(() => page.locator('.viewer-stage > img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('skip holds the current camera and reset makes the full entrance replayable', async ({ page }) => {
  await openGalaxy(page);
  await startJourney(page);
  await expect.poll(async () => Number(await scene(page).getAttribute('data-journey-progress'))).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '跳过入场', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'cancelled');
  const stoppedPosition = await vector(scene(page), 'data-camera-position');
  const stoppedTarget = await vector(scene(page), 'data-camera-target');
  await expectFullControls(page);
  await expectNoDelayedArrival(page);
  expect(displacement(stoppedPosition, await vector(scene(page), 'data-camera-position'))).toBeLessThan(0.05);
  expect(displacement(stoppedTarget, await vector(scene(page), 'data-camera-target'))).toBeLessThan(0.05);
  await page.getByRole('button', { name: '重置视角', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始漫游', exact: true })).toBeVisible();
  await startJourney(page);
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
  await expect(arrival(page)).toBeVisible();
  await arrival(page).getByRole('button', { name: '继续自由探索' }).click();
  await expect(arrival(page)).toHaveCount(0);
  await expectFullControls(page);
  await expect(scene(page)).toBeFocused();
});

test('mouse drag, wheel, and WASD each cancel the flight and immediately control the real camera', async ({ page }) => {
  for (const gesture of ['drag', 'wheel', 'keyboard'] as const) {
    await openGalaxy(page);
    await startJourney(page);
    const position = await vector(scene(page), 'data-camera-position');
    const target = await vector(scene(page), 'data-camera-target');
    if (gesture === 'drag') {
      await page.mouse.move(950, 420);
      await page.mouse.down();
      await page.mouse.move(1160, 490, { steps: 12 });
      await page.mouse.up();
      await expect.poll(async () => displacement(position, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(2);
    } else if (gesture === 'wheel') {
      const beforeDistance = Number(await scene(page).getAttribute('data-camera-distance'));
      await page.mouse.move(950, 420);
      await page.mouse.wheel(0, -500);
      await expect.poll(async () => Number(await scene(page).getAttribute('data-camera-distance'))).toBeLessThan(beforeDistance * 0.9);
    } else {
      await page.keyboard.down('w');
      await expect.poll(async () => displacement(target, await vector(scene(page), 'data-camera-target'))).toBeGreaterThan(1);
      await page.keyboard.up('w');
    }
    await expect(scene(page)).toHaveAttribute('data-journey-state', 'cancelled');
    await expectFullControls(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoDelayedArrival(page);
  }
});

test('opening overview or the text editor cancels entrance without resuming on return', async ({ page }) => {
  for (const destination of ['overview', 'editor'] as const) {
    await openGalaxy(page);
    await startJourney(page);
    await page.getByRole('button', { name: destination === 'overview' ? '相册总览' : '编辑文字', exact: true }).click();
    await expect(scene(page)).toHaveAttribute('data-journey-state', 'cancelled');
    await expect(scene(page)).toHaveAttribute('data-scene-state', 'paused');
    const pausedPosition = await vector(scene(page), 'data-camera-position');
    if (destination === 'overview') {
      await expect(page.locator('.gallery-card')).toHaveCount(99);
      await page.getByRole('button', { name: '星空漫游', exact: true }).click();
    } else {
      const editor = page.getByRole('dialog', { name: '编辑相册文字' });
      await expect(editor).toBeVisible();
      await editor.getByRole('button', { name: '关闭', exact: true }).click();
    }
    await expectNoDelayedArrival(page);
    expect(displacement(pausedPosition, await vector(scene(page), 'data-camera-position'))).toBeLessThan(0.05);
    await expectFullControls(page);
  }
});

test('reduced motion goes directly to the first memory without a long camera animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGalaxy(page);
  const position = await vector(scene(page), 'data-camera-position');
  await page.getByRole('button', { name: '开始漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived', { timeout: 1200 });
  await expect(scene(page)).toHaveAttribute('data-journey-progress', '1');
  await expect(arrival(page)).toBeVisible();
  await expect(page.locator('.journey-indicator')).toHaveCount(0);
  expect(displacement(position, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(5);
});

test.describe('phone entrance', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  test('touch entrance arrives without overflow and both free exploration and a swipe restore controls', async ({ page }, testInfo) => {
    await openGalaxy(page);
    await page.getByRole('button', { name: '开始漫游', exact: true }).tap();
    await expect(scene(page)).toHaveAttribute('data-journey-state', 'flying');
    await expect(page.locator('.journey-indicator')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
    await expect(arrival(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-journey-arrived.png') });
    await arrival(page).getByRole('button', { name: '继续自由探索' }).tap();
    await expect(arrival(page)).toHaveCount(0);
    await expectFullControls(page);
    const beforeZoom = Number(await scene(page).getAttribute('data-camera-distance'));
    await page.getByRole('button', { name: '拉近', exact: true }).tap();
    await expect.poll(async () => Number(await scene(page).getAttribute('data-camera-distance'))).toBeLessThan(beforeZoom * 0.9);
    await page.getByRole('button', { name: '重置视角', exact: true }).tap();
    await page.getByRole('button', { name: '开始漫游', exact: true }).tap();
    await expect(scene(page)).toHaveAttribute('data-journey-state', 'flying');
    const position = await vector(scene(page), 'data-camera-position');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 410 }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 100 + 15 * step, y: 410 + 5 * step }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect(scene(page)).toHaveAttribute('data-journey-state', 'cancelled');
    await expect.poll(async () => displacement(position, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(2);
    await expectFullControls(page);
    await expectNoDelayedArrival(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
