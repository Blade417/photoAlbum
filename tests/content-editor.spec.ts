import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures';
import { createDemoManifest } from '../scripts/media-manifest.mjs';
import { DEFAULT_CONTENT, validateContent, type AlbumContent } from '../shared/album-content.mjs';

// Every request that could write album-content.json is intercepted in memory.
// The suite never overwrites the album owner's project content.
async function mockProject(page: Page, options: { browser?: boolean; failSave?: boolean } = {}) {
  let saved = validateContent(DEFAULT_CONTENT);
  let writes = 0;
  await page.route('**/media-manifest.json', route => route.fulfill({ json: createDemoManifest() }));
  await page.route('**/album-content.json', route => route.fulfill({ json: DEFAULT_CONTENT }));
  await page.route('**/__album/content', async route => {
    if (options.browser) return route.fulfill({ status: 403, json: { error: 'Browser-only fixture' } });
    if (route.request().method() === 'PUT') {
      writes++;
      if (options.failSave) return route.fulfill({ status: 500, json: { error: '模拟写入失败' } });
      saved = validateContent(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { content: saved, writable: true } });
  });
  return { value: () => saved, writes: () => writes };
}

const editor = (page: Page) => page.getByRole('dialog', { name: '编辑相册文字' });
const field = (page: Page, label: string) => editor(page).getByLabel(new RegExp(`^${label}`));

async function openEditor(page: Page) {
  await page.getByRole('button', { name: '编辑文字', exact: true }).click();
  await expect(editor(page)).toBeVisible();
}

async function exportDraft(page: Page): Promise<AlbumContent> {
  const downloadEvent = page.waitForEvent('download');
  await editor(page).getByRole('button', { name: '导出', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('album-content.json');
  const path = await download.path();
  expect(path).toBeTruthy();
  return validateContent(JSON.parse(await readFile(path!, 'utf8')));
}

test('page and memory text save to the project and survive a reload', async ({ page }, testInfo) => {
  const fixture = await mockProject(page);
  await page.goto('/');
  await openEditor(page);
  await expect(editor(page).locator('.editor-storage')).toContainText('保存到项目文件');
  await field(page, '相册名称').fill('我们的星河');
  await field(page, '首页标题 · 第一行').fill('一起走过，');
  await field(page, '首页介绍').fill('把生活里的每一束光\n都收藏在这里。');
  await editor(page).getByRole('tab', { name: '照片与视频' }).click();
  await field(page, '回忆标题').fill('第一次看雪山');
  await field(page, '回忆说明').fill('这一刻的风，和身边的你。');
  await editor(page).getByRole('button', { name: '保存到项目', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('已保存到项目');
  expect(fixture.writes()).toBe(1);
  expect(fixture.value().memories.demo['memory-001']).toEqual({ title: '第一次看雪山', subtitle: '这一刻的风，和身边的你。' });
  expect(fixture.value().memories.personal).toEqual({});
  await expect(editor(page).getByRole('button', { name: '保存到项目', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('desktop-editor-saved.png'), animations: 'disabled' });
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('一起走过，');
  await page.reload();
  await expect(page.getByRole('link', { name: '我们的星河首页' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('一起走过，');
  await page.getByRole('button', { name: '查看照片：第一次看雪山', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '第一次看雪山' })).toContainText('这一刻的风，和身边的你。');
});

test('valid import stays a draft until saved and exported JSON matches all content', async ({ page }) => {
  const fixture = await mockProject(page);
  await page.goto('/');
  await openEditor(page);
  const imported = validateContent(DEFAULT_CONTENT);
  imported.site.name = '导入的宇宙';
  imported.site.description = '一段来自配置文件的介绍。';
  imported.memories.demo['memory-009'] = { title: '雨后的路', subtitle: '视频说明也可以导入。' };
  imported.memories.personal['memory-099'] = { title: '未放入的素材', subtitle: '保存时仍保留另一组说明。' };
  await editor(page).getByLabel('导入文字配置').setInputFiles({ name: 'words.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await expect(editor(page).getByRole('status')).toContainText('配置已载入编辑区');
  expect(fixture.writes()).toBe(0);
  await expect(field(page, '相册名称')).toHaveValue('导入的宇宙');
  expect(await exportDraft(page)).toEqual(imported);
  await editor(page).getByRole('button', { name: '保存到项目', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('已保存到项目');
  expect(fixture.value()).toEqual(imported);
  await page.reload();
  await expect(page.getByRole('link', { name: '导入的宇宙首页' })).toBeVisible();
});

test('invalid imports and failed saves preserve edits; close can keep or discard the draft', async ({ page }) => {
  const fixture = await mockProject(page, { failSave: true });
  await page.goto('/');
  await openEditor(page);
  await field(page, '相册名称').fill('先留在编辑器');
  await editor(page).getByLabel('导入文字配置').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":2}') });
  await expect(editor(page).getByRole('alert')).toBeVisible();
  await expect(field(page, '相册名称')).toHaveValue('先留在编辑器');
  await editor(page).getByRole('button', { name: '保存到项目', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('工程文件未保存');
  await expect(editor(page).getByRole('status')).toHaveCount(0);
  await expect(field(page, '相册名称')).toHaveValue('先留在编辑器');
  expect(fixture.value()).toEqual(DEFAULT_CONTENT);
  expect((await exportDraft(page)).site.name).toBe('先留在编辑器');
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click();
  await expect(editor(page)).toContainText('还有未保存的文字');
  await editor(page).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(field(page, '相册名称')).toHaveValue('先留在编辑器');
  await page.keyboard.press('Escape');
  await editor(page).getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await openEditor(page);
  await expect(field(page, '相册名称')).toHaveValue(DEFAULT_CONTENT.site.name);
});

test('browser-only mode persists locally and storage failure keeps an exportable draft', async ({ page }) => {
  const fixture = await mockProject(page, { browser: true });
  await page.goto('/');
  await openEditor(page);
  await expect(editor(page).locator('.editor-storage')).toContainText('保存到本机浏览器');
  await field(page, '相册名称').fill('只在这台电脑');
  await editor(page).getByRole('button', { name: '保存到本机', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('已保存到本机浏览器');
  await expect(editor(page).getByRole('status')).not.toContainText('已保存到项目');
  expect(fixture.writes()).toBe(0);
  await page.reload();
  await expect(page.getByRole('link', { name: '只在这台电脑首页' })).toBeVisible();
  await openEditor(page);
  await expect(field(page, '相册名称')).toHaveValue('只在这台电脑');
  expect((await exportDraft(page)).site.name).toBe('只在这台电脑');
  await field(page, '相册名称').fill('无法写入的修改');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); }; });
  await editor(page).getByRole('button', { name: '保存到本机', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('无法保存到本机');
  await expect(editor(page).getByRole('status')).toHaveCount(0);
  await expect(field(page, '相册名称')).toHaveValue('无法写入的修改');
  expect((await exportDraft(page)).site.name).toBe('无法写入的修改');
  await page.keyboard.press('Escape');
  await editor(page).getByRole('button', { name: '放弃更改并关闭', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('link', { name: '只在这台电脑首页' })).toBeVisible();
});

test.describe('phone content maintenance', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  test('page and memory fields fit at 390px and the save action stays usable', async ({ page }, testInfo) => {
    const fixture = await mockProject(page);
    await page.goto('/');
    await openEditor(page);
    await field(page, '相册名称').fill('手机里的回忆');
    const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.editor-backdrop, .editor-body, .editor-toolbar')).every(element => element.scrollWidth <= element.clientWidth + 1));
    expect(await noHorizontalOverflow()).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-editor-site.png'), animations: 'disabled' });
    await editor(page).getByRole('tab', { name: '照片与视频' }).tap();
    await editor(page).getByLabel('搜索回忆').fill('memory-009');
    await expect(editor(page).locator('.memory-choice')).toHaveCount(1);
    await editor(page).locator('.memory-choice').tap();
    await field(page, '回忆说明').fill('在手机上维护视频说明，然后保存。');
    expect(await noHorizontalOverflow()).toBe(true);
    await editor(page).getByRole('button', { name: '保存到项目', exact: true }).tap();
    await expect(editor(page).getByRole('status')).toContainText('已保存到项目');
    expect(fixture.value().memories.demo['memory-009'].subtitle).toBe('在手机上维护视频说明，然后保存。');
    await page.screenshot({ path: testInfo.outputPath('mobile-editor-memory.png'), animations: 'disabled' });
    await page.reload();
    await expect(page.getByRole('link', { name: '手机里的回忆首页' })).toBeVisible();
  });
});
