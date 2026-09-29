import { expect, test, type Page } from './fixtures';
import path from 'node:path';
import { DEFAULT_CONTENT } from '../shared/album-content.mjs';

// All network fixtures use bundled demos; private originals are never opened.
test.use({ reducedMotion: 'reduce' });

function fixtureManifest(optimized = true) {
  return {
    isDemo: false,
    items: Array.from({ length: 16 }, (_, offset) => {
      const index = offset + 1;
      const video = index !== 1;
      return {
        id: `performance-${index}`,
        index,
        type: video ? 'video' : 'image',
        title: `${video ? '视频' : '照片'}性能样本 ${index}`,
        subtitle: '独立验收素材',
        src: `performance/original-${index}.${video ? 'mp4' : 'jpg'}`,
        thumbnail: `performance/thumbnail-${index}.jpg`,
        ...(optimized ? {
          previewSrc: `performance/preview-${index}.${video ? 'mp4' : 'jpg'}`,
          ...(!video ? { displaySrc: `performance/display-${index}.jpg` } : {}),
        } : {}),
      };
    }),
  };
}

async function openFixtures(page: Page, optimized = true) {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/performance/')) requests.push(pathname);
  });
  await page.route('**/media-manifest.json', route => route.fulfill({ json: fixtureManifest(optimized) }));
  await page.route('**/__album/content', route => route.fulfill({ json: { content: DEFAULT_CONTENT, writable: true } }));
  await page.route('**/album-content.json', route => route.fulfill({ json: DEFAULT_CONTENT }));
  await page.route('**/performance/**', route => {
    const video = new URL(route.request().url()).pathname.endsWith('.mp4');
    return route.fulfill({
      path: path.resolve('public/demo', video ? 'flower.mp4' : 'alpine.jpg'),
      contentType: video ? 'video/mp4' : 'image/jpeg',
    });
  });
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-card-count', '16');
  await expect(page.locator('.loading-indicator')).toHaveCount(0);
  return { requests, errors };
}

const scene = (page: Page) => page.locator('.galaxy-scene canvas');
const pool = (page: Page) => page.locator('[data-album-video-pool] video');
const originals = (requests: string[]) => requests.filter(source => source.includes('/original-'));

test('scene and gallery use derivatives, and details load the appropriate larger media on demand', async ({ page }) => {
  const { requests, errors } = await openFixtures(page);
  await expect.poll(() => requests.some(source => source === '/performance/preview-1.jpg')).toBe(true);
  await expect.poll(() => requests.some(source => /preview-\d+\.mp4$/.test(source))).toBe(true);
  expect(originals(requests)).toEqual([]);
  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(16);
  const thumbnails = await page.locator('.gallery-card img').evaluateAll(images => images.map(image => image.getAttribute('src')));
  expect(thumbnails).toHaveLength(16);
  expect(thumbnails.every(source => source?.includes('/performance/thumbnail-'))).toBe(true);
  expect(originals(requests)).toEqual([]);

  await page.locator('.gallery-card').first().click();
  await expect(page.locator('.viewer-stage > img')).toHaveAttribute('src', '/performance/display-1.jpg');
  await expect.poll(() => page.locator('.viewer-stage > img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: '下载原文件' })).toHaveAttribute('href', '/performance/original-1.jpg');
  expect(originals(requests)).toEqual([]);
  await page.getByRole('button', { name: '下一张', exact: true }).click();
  const detailVideo = page.locator('.viewer-stage video');
  await expect(detailVideo).toHaveAttribute('src', '/performance/original-2.mp4');
  await expect.poll(() => detailVideo.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  expect(new Set(originals(requests))).toEqual(new Set(['/performance/original-2.mp4']));
  expect(errors).toEqual([]);
});

test('visible previews autoplay within the cap and release resident sources when the scene is hidden', async ({ page }) => {
  const { requests, errors } = await openFixtures(page);
  await expect(scene(page)).toHaveAttribute('data-video-concurrency-limit', '4');
  await expect.poll(async () => Number(await scene(page).getAttribute('data-video-playing'))).toBe(4);
  const playing = page.locator('[data-album-video-pool] video[src]').first();
  await expect.poll(() => playing.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0.25);
  const initial = await playing.evaluate(video => ({
    time: (video as HTMLVideoElement).currentTime,
    source: video.getAttribute('src')!,
    muted: (video as HTMLVideoElement).muted,
    loop: (video as HTMLVideoElement).loop,
  }));
  expect(initial.muted).toBe(true);
  expect(initial.loop).toBe(true);
  await expect.poll(() => playing.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(initial.time + 0.15);
  expect(await pool(page).evaluateAll(videos => videos.filter(video => video.hasAttribute('src')).length)).toBeLessThanOrEqual(6);
  expect(originals(requests)).toEqual([]);

  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-video-playing', '0');
  await expect(scene(page)).toHaveAttribute('data-video-resident-sources', '0');
  expect(await pool(page).evaluateAll(videos => videos.every(video => !video.hasAttribute('src') && (video as HTMLVideoElement).readyState === 0))).toBe(true);
  await page.getByRole('button', { name: '星空漫游', exact: true }).click();
  await expect.poll(async () => Number(await scene(page).getAttribute('data-video-playing'))).toBe(4);
  const resumed = page.locator(`[data-album-video-pool] video[data-source="${initial.source}"]`);
  await expect.poll(() => resumed.evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(initial.time);
  await expect(scene(page)).toHaveAttribute('data-video-errors', '0');
  expect(originals(requests)).toEqual([]);
  expect(errors).toEqual([]);
});

test('unoptimized video sources remain lazy and only visible sources are fetched', async ({ page }) => {
  const { requests, errors } = await openFixtures(page, false);
  await expect.poll(async () => Number(await scene(page).getAttribute('data-video-playing'))).toBe(4);
  const videoRequests = new Set(originals(requests).filter(source => source.endsWith('.mp4')));
  expect(videoRequests.size).toBe(4);
  expect(await page.locator('[data-album-video-pool] video[src]').count()).toBe(4);
  await expect(pool(page)).toHaveCount(15);
  expect(errors).toEqual([]);
});

test('phone viewport uses no more than two concurrent video previews', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requests, errors } = await openFixtures(page);
  await expect(scene(page)).toHaveAttribute('data-video-concurrency-limit', '2');
  await expect.poll(async () => Number(await scene(page).getAttribute('data-video-playing'))).toBe(2);
  expect(await page.locator('[data-album-video-pool] video[src]').count()).toBe(2);
  expect(originals(requests)).toEqual([]);
  expect(errors).toEqual([]);
});
