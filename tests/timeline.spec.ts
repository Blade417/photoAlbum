import { expect, test, type Locator, type Page } from './fixtures';
import sharp from 'sharp';
import { createDemoManifest } from '../scripts/media-manifest.mjs';
import { DEFAULT_CONTENT, validateContent } from '../shared/album-content.mjs';

// Personal-album fixtures reuse the bundled demo files; public/media and saved text are never touched.
const demo = createDemoManifest().items;
const pad = (value: number) => String(value).padStart(2, '0');
const scene = (page: Page) => page.locator('.galaxy-scene canvas');
const arrival = (page: Page) => page.getByRole('region', { name: '已抵达一段回忆' });
const vector = async (canvas: Locator, attribute: string): Promise<number[]> => JSON.parse((await canvas.getAttribute(attribute))!);

type FixtureItem = ReturnType<typeof createDemoManifest>['items'][number] & { takenAt?: string };

/** Numbered in shooting order, like an album that grows over the years. */
function datedManifest(count: number, from: number, to: number, override: (index: number) => string | undefined = () => undefined) {
  const start = Date.UTC(from, 0, 10);
  const end = Date.UTC(to, 5, 20);
  return {
    isDemo: false,
    items: Array.from({ length: count }, (_, offset): FixtureItem => {
      const index = offset + 1;
      const { demo: _demo, ...base } = demo[offset % demo.length]!;
      const takenAt = override(index) ?? new Date(start + (end - start) * offset / Math.max(1, count - 1)).toISOString().slice(0, 19);
      return { ...base, id: `memory-${String(index).padStart(3, '0')}`, index, title: `旅行 ${index}`, subtitle: '时间星河验收', takenAt };
    }),
  };
}

async function mockAlbum(page: Page, manifest: object) {
  let saved = validateContent(DEFAULT_CONTENT);
  await page.route('**/media-manifest.json', route => route.fulfill({ json: manifest }));
  await page.route('**/album-content.json', route => route.fulfill({ json: DEFAULT_CONTENT }));
  await page.route('**/__album/content', async route => {
    if (route.request().method() !== 'PUT') return route.fulfill({ json: { content: saved, writable: true } });
    saved = validateContent(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  return { saved: () => saved };
}

async function openGalaxy(page: Page, count: number) {
  await page.goto('/');
  await expect(scene(page)).toHaveAttribute('data-card-count', String(count));
  await expect(page.locator('.loading-indicator')).toHaveCount(0);
}

test('an album beyond 99 memories is laid out by time and can travel to a chosen year', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const manifest = datedManifest(180, 2019, 2026);
  await mockAlbum(page, manifest);
  await openGalaxy(page, 180);
  await expect(page.locator('.dock-summary')).toContainText('180 个瞬间');
  await expect(page.locator('.dock-caption')).toContainText('2019 — 2026');
  await expect(scene(page)).toHaveAttribute('data-year-rings', /^[1-9]/);
  const newest = manifest.items.at(-1)!;
  await expect(page.locator('.strip-thumbnail').first()).toHaveAccessibleName(`查看${newest.type === 'video' ? '视频' : '照片'}：${newest.title}`);

  await page.getByRole('button', { name: /^时间坐标/ }).click();
  const years = page.getByRole('group', { name: '穿越到某一年' }).getByRole('button');
  await expect(years).toHaveCount(8);
  await expect(years.first()).toContainText('2026');
  await page.screenshot({ path: testInfo.outputPath('time-menu.png') });
  await page.getByRole('button', { name: /^穿越到 2019 年/ }).click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
  // Travelling back reaches a year at its latest memory, far behind the recent ones.
  const latest2019 = manifest.items.filter(item => item.takenAt!.startsWith('2019')).at(-1)!;
  await expect(scene(page)).toHaveAttribute('data-journey-target-id', latest2019.id);
  expect((await vector(scene(page), 'data-journey-target-position'))[2]).toBeLessThan(-100);
  await expect(arrival(page).locator('.eyebrow')).toContainText('TIME TRAVEL · 2019');
  await expect(arrival(page).locator('.arrival-date')).toHaveText(latest2019.takenAt!.slice(0, 10).replaceAll('-', '.'));
  await expect(scene(page)).toHaveAttribute('data-era', '2019');
  await expect(page.getByRole('button', { name: /^时间坐标：2019/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('year-arrival.png') });

  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await expect(page.locator('.gallery-card')).toHaveCount(180);
  await expect(page.locator('.gallery-year-title span')).toHaveText(['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019']);
  await expect(page.locator('.gallery-year').first().locator('.card-caption h3').first()).toHaveText(newest.title);
  await page.locator('.gallery-year').last().locator('.gallery-card').first().click();
  await expect(page.getByRole('dialog', { name: latest2019.title })).toContainText(latest2019.takenAt!.slice(0, 10).replaceAll('-', '.'));
  expect(errors).toEqual([]);
});

test('filters light up matching memories in place instead of rebuilding the galaxy', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockAlbum(page, createDemoManifest());
  await openGalaxy(page, 99);
  await expect(scene(page)).toHaveAttribute('data-highlight-count', '99');
  const canvas = await scene(page).elementHandle();
  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await page.getByRole('button', { name: '视频 11', exact: true }).click();
  await page.getByRole('button', { name: '星空漫游', exact: true }).click();
  await expect(scene(page)).toHaveAttribute('data-highlight-count', '11');
  await expect(scene(page)).toHaveAttribute('data-card-count', '99');
  expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: /仅看视频/ }).click();
  await expect(scene(page)).toHaveAttribute('data-highlight-count', '99');
  expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
});

test('a lifetime of memories keeps far ones as stars and bounds decoded previews', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const tiny = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#8b9aca' } }).jpeg().toBuffer();
  await page.route('**/lifetime/**', route => route.fulfill({ body: tiny, contentType: 'image/jpeg' }));
  const manifest = datedManifest(320, 2004, 2026);
  // Distinct previews, so every memory needs its own texture.
  manifest.items = manifest.items.map(item => ({ ...item, type: 'image', src: `lifetime/original-${item.index}.jpg`, thumbnail: `lifetime/thumb-${item.index}.jpg`, previewSrc: `lifetime/preview-${item.index}.jpg` }));
  await mockAlbum(page, manifest);
  await openGalaxy(page, 320);
  await expect.poll(async () => Number(await scene(page).getAttribute('data-distant-memories'))).toBeGreaterThan(50);
  await expect.poll(async () => Number(await scene(page).getAttribute('data-resident-textures'))).toBeGreaterThan(100);
  await page.getByRole('button', { name: /^时间坐标/ }).click();
  await page.getByRole('button', { name: /^穿越到 2004 年/ }).click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
  // Previews left behind near the present are released once the old ones load.
  await expect.poll(async () => Number(await scene(page).getAttribute('data-resident-textures')), { timeout: 20_000 }).toBeLessThanOrEqual(150);
  await expect(arrival(page).getByRole('heading')).toHaveText(manifest.items.filter(item => item.takenAt!.startsWith('2004')).at(-1)!.title);
  expect(errors).toEqual([]);
});

test('on this day offers a journey to the same date in earlier years', async ({ page }) => {
  const today = new Date();
  test.skip(today.getMonth() === 1 && today.getDate() === 29, 'Leap day has no yearly anniversary to fixture reliably.');
  const sameDay = (year: number) => `${year}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T09:30:00`;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const manifest = datedManifest(40, 2018, today.getFullYear() - 1, index => index === 7 ? sameDay(today.getFullYear() - 3) : index === 23 ? sameDay(today.getFullYear() - 1) : undefined);
  // Keep the evenly spread fixture dates from landing on today by coincidence.
  const todayKey = `-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T`;
  for (const item of manifest.items) {
    if (item.index !== 7 && item.index !== 23 && item.takenAt!.includes(todayKey)) item.takenAt = item.takenAt!.replace(todayKey, `-${pad(today.getMonth() + 1)}-${pad(today.getDate() === 1 ? 2 : 1)}T`);
  }
  await mockAlbum(page, manifest);
  await openGalaxy(page, 40);
  const revisit = page.getByRole('button', { name: /^那年今日/ });
  await expect(revisit).toContainText('2 段回忆');
  await revisit.click();
  await expect(scene(page)).toHaveAttribute('data-journey-state', 'arrived');
  await expect(scene(page)).toHaveAttribute('data-journey-target-id', /^memory-0(07|23)$/);
  await expect(arrival(page).locator('.eyebrow')).toContainText('ON THIS DAY');
  await expect(arrival(page).locator('.arrival-kicker')).toHaveText(/^[13] 年前的今天。$/);
});

test('a corrected date in the editor moves the memory into its year and is saved', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const manifest = datedManifest(30, 2022, 2024);
  delete manifest.items[4]!.takenAt;
  const album = await mockAlbum(page, manifest);
  await openGalaxy(page, 30);
  await page.getByRole('button', { name: '相册总览', exact: true }).click();
  await expect(page.getByRole('region', { name: '未标注日期' })).toContainText('旅行 5');
  await page.getByRole('button', { name: '编辑文字', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑相册文字' });
  await editor.getByRole('tab', { name: '照片与视频' }).click();
  await editor.getByLabel('搜索回忆').fill('memory-005');
  await editor.locator('.memory-choice').click();
  await expect(editor.getByLabel(/^拍摄日期/)).toHaveValue('');
  await editor.getByLabel(/^拍摄日期/).fill('2015-06-18');
  await editor.getByRole('button', { name: '保存到项目', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('已保存到项目');
  expect(album.saved().memories.personal['memory-005']).toEqual({ title: '旅行 5', subtitle: '时间星河验收', date: '2015-06-18' });
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('region', { name: '2015 年' })).toContainText('旅行 5');
  await expect(page.getByRole('region', { name: '未标注日期' })).toHaveCount(0);
});
