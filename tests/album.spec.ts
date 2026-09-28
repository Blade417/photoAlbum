import { expect, test, type Locator, type Page } from '@playwright/test';
import { createDemoManifest } from '../scripts/media-manifest.mjs';
import { DEFAULT_CONTENT } from '../shared/album-content.mjs';

// Browser acceptance uses the bundled 99-item demo and never changes public/media.
// Run: npx playwright test. Chrome must be installed on this machine.
test.beforeEach(async ({ page }) => {
  // Isolate demo acceptance from any personal media the album owner later adds.
  // Real bundled image/video requests are still loaded and decoded by Chrome.
  await page.route('**/media-manifest.json', route => route.fulfill({ json: createDemoManifest() }));
  await page.route('**/__album/content', route => route.fulfill({ json: { content: DEFAULT_CONTENT, writable: true } }));
});

const scene = (page: Page) => page.locator('.galaxy-scene canvas');
const dialog = (page: Page) => page.getByRole('dialog');
const vector = async (canvas: Locator, attribute: string): Promise<number[]> =>
  JSON.parse((await canvas.getAttribute(attribute))!);
const displacement = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
const distance = async (canvas: Locator) => Number(await canvas.getAttribute('data-camera-distance'));

async function openGalaxy(page: Page) {
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-card-count', '99');
  await expect(scene(page)).toHaveAttribute('data-camera-position', /^\[/);
  await expect(page.locator('.loading-indicator')).toHaveCount(0);
  await expect(page.locator('.manifest-warning')).toHaveCount(0);
}

async function stopRoaming(page: Page) {
  const pause = page.getByRole('button', { name: '暂停自动漫游' });
  if (await pause.count()) await pause.click();
  await expect(page.getByRole('button', { name: '开启自动漫游' })).toBeVisible();
}

test('desktop loads 99 memories and image viewer supports next and Escape', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGalaxy(page);
  await expect(page.locator('.dock-summary')).toContainText('99 / 99');
  await expect(page.locator('.strip-thumbnail')).toHaveCount(8);
  await expect.poll(() => page.locator('.strip-thumbnail img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-galaxy.png') });
  await page.getByRole('button', { name: '查看照片：山的另一边', exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName('山的另一边');
  await expect.poll(() => page.locator('.viewer-stage > img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.viewer-counter')).toContainText('01 / 99');
  await page.getByRole('button', { name: '下一张', exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName('湖泊的来信');
  await expect(page.locator('.viewer-counter')).toContainText('02 / 99');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog(page)).toHaveAccessibleName('山的另一边');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看照片：山的另一边', exact: true })).toBeFocused();
  await stopRoaming(page);
  const beforeFocus = await vector(scene(page), 'data-camera-target');
  const beforeFocusDistance = await distance(scene(page));
  // Click the center of the prominent mountain card in the actual WebGL scene.
  await page.mouse.click(780, 475);
  await expect(dialog(page)).toHaveAccessibleName('山的另一边');
  await page.getByRole('button', { name: '在星空中靠近' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => displacement(beforeFocus, await vector(scene(page), 'data-camera-target'))).toBeGreaterThan(1);
  await expect.poll(() => distance(scene(page))).toBeLessThan(beforeFocusDistance * 0.8);
  expect(errors).toEqual([]);
});

test('overview filters 88 images and 11 videos, and local video actually plays', async ({ page }, testInfo) => {
  await openGalaxy(page);
  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(99);
  await expect(scene(page)).toHaveAttribute('data-scene-state', 'paused');
  await page.getByRole('button', { name: '照片 88', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(88);
  await expect(page.locator('.card-type').first()).toHaveText('PHOTO');
  await page.getByRole('button', { name: '视频 11', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(11);
  await expect(page.locator('.card-type').first()).toHaveText('VIDEO');
  await page.locator('.gallery-card').first().click();
  const video = dialog(page).locator('video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  const initialTime = await video.evaluate(element => (element as HTMLVideoElement).currentTime);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(initialTime + 0.2);
  expect(await video.evaluate(element => (element as HTMLVideoElement).error)).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('desktop-video.png') });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.viewer-stage video')).toHaveCount(0);
  await page.getByRole('button', { name: '全部 99', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(99);
});

test('help dialog traps focus, restores it on Escape, and immersive mode exits', async ({ page }) => {
  await openGalaxy(page);
  const helpButton = page.getByRole('button', { name: '操作指南', exact: true });
  await helpButton.click();
  await expect(dialog(page)).toHaveAccessibleName('星空漫游指南');
  const closeButton = dialog(page).getByRole('button', { name: '关闭', exact: true });
  const startButton = dialog(page).getByRole('button', { name: '去星空里看看' });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(startButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();
  await expect(scene(page)).toHaveAttribute('data-scene-state', 'paused');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(helpButton).toBeFocused();
  await page.getByRole('button', { name: '沉浸模式', exact: true }).click();
  await expect(page.locator('main')).toHaveClass(/is-immersive/);
  await expect(page.getByRole('button', { name: '退出沉浸模式', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('main')).not.toHaveClass(/is-immersive/);
  await expect(page.getByRole('button', { name: '退出沉浸模式', exact: true })).toHaveCount(0);
});

test('zoom buttons, drag, wheel and W move the real camera, and reset restores home', async ({ page }) => {
  await openGalaxy(page);
  await stopRoaming(page);
  const canvas = scene(page);
  const initialDistance = await distance(canvas);
  await page.getByRole('button', { name: '拉近', exact: true }).click();
  await expect.poll(() => distance(canvas)).toBeLessThan(initialDistance * 0.85);
  await page.getByRole('button', { name: '拉远', exact: true }).click();
  await expect.poll(() => distance(canvas)).toBeGreaterThan(initialDistance * 0.9);
  // Both endpoints are in the unobstructed middle of the WebGL canvas.
  const beforeDrag = await vector(canvas, 'data-camera-position');
  await page.mouse.move(900, 420);
  await page.mouse.down();
  await page.mouse.move(1100, 490, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => displacement(beforeDrag, await vector(canvas, 'data-camera-position'))).toBeGreaterThan(2);
  await expect(dialog(page)).toHaveCount(0);
  const beforeWheel = await distance(canvas);
  await page.mouse.wheel(0, -500);
  await expect.poll(() => distance(canvas)).toBeLessThan(beforeWheel * 0.9);
  // Starting exploration must move focus away from the UI and enable WASD immediately.
  await page.getByRole('button', { name: '开始漫游', exact: true }).click();
  await expect(canvas).toBeFocused();
  const beforeWalk = await vector(canvas, 'data-camera-target');
  await page.keyboard.down('w');
  await expect.poll(async () => displacement(beforeWalk, await vector(canvas, 'data-camera-target'))).toBeGreaterThan(1);
  await page.keyboard.up('w');
  await page.getByRole('button', { name: '重置视角', exact: true }).click();
  await stopRoaming(page);
  await expect.poll(async () => displacement([0, 0, 0], await vector(canvas, 'data-camera-target'))).toBeLessThan(0.05);
  await expect.poll(() => distance(canvas)).toBeGreaterThan(46.9);
  await expect.poll(() => distance(canvas)).toBeLessThan(47.1);
});

test.describe('mobile touch viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  test('fits phone viewport, opens a photo, and touch swipe rotates the camera', async ({ page }, testInfo) => {
    await openGalaxy(page);
    await stopRoaming(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-galaxy.png') });
    await page.locator('.strip-thumbnail').first().tap();
    await expect(dialog(page)).toBeVisible();
    await expect.poll(() => page.locator('.viewer-stage > img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-photo.png') });
    await dialog(page).getByRole('button', { name: '关闭', exact: true }).tap();
    await page.getByRole('button', { name: '相册总览', exact: true }).tap();
    await expect(page.locator('.gallery-card')).toHaveCount(99);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-overview.png') });
    await page.getByRole('button', { name: '星空漫游', exact: true }).tap();
    await page.getByRole('button', { name: '开始漫游', exact: true }).tap();
    const beforeTouch = await vector(scene(page), 'data-camera-position');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 410 }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120 + 15 * step, y: 410 + 5 * step }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => displacement(beforeTouch, await vector(scene(page), 'data-camera-position'))).toBeGreaterThan(2);
    await expect(dialog(page)).toHaveCount(0);
    // Wait for inertial movement to settle before beginning the next touch gesture.
    let previousPosition = await vector(scene(page), 'data-camera-position');
    let stableReadings = 0;
    await expect.poll(async () => {
      const currentPosition = await vector(scene(page), 'data-camera-position');
      const delta = displacement(previousPosition, currentPosition);
      previousPosition = currentPosition;
      stableReadings = delta < 0.02 ? stableReadings + 1 : 0;
      return stableReadings;
    }, { intervals: [250] }).toBeGreaterThanOrEqual(3);
    await page.getByRole('button', { name: '相册总览', exact: true }).tap();
    await expect(page.locator('.gallery-card')).toHaveCount(99);
    await cdp.detach();
  });
});

test('WebGL unavailable falls back to a usable image and video grid', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string, options?: unknown) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(contextId)) return null;
      return nativeGetContext.call(this, contextId as '2d', options);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto('/');
  await expect(page.locator('.notice')).toContainText('当前浏览器无法启用 3D 星空');
  await expect(page.locator('.gallery-card')).toHaveCount(99);
  await expect(page.getByRole('button', { name: '星空漫游', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('webgl-fallback.png') });
  await page.locator('.gallery-card').first().click();
  await expect(dialog(page)).toBeVisible();
  await expect.poll(() => page.locator('.viewer-stage > img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '在星空中靠近' })).toHaveCount(0);
});

test('missing media manifest shows an explicit warning and keeps 99 demo memories usable', async ({ page }) => {
  await page.route('**/media-manifest.json', route => route.fulfill({ status: 404, body: 'missing manifest' }));
  await page.goto('/');
  await expect(page.locator('.manifest-warning')).toContainText('素材清单暂时无法读取');
  await expect(page.locator('.manifest-warning')).toContainText('media-manifest.json');
  await expect(scene(page)).toHaveAttribute('data-card-count', '99');
  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(99);
  await page.getByRole('button', { name: '视频 11', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(11);
});
