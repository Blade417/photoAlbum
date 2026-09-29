import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { scanMediaDirectory } from './media-manifest.mjs';
import { importMedia, moveWithoutOverwrite } from './media-import.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-album-import-test-'));
  const media = path.join(root, 'public', 'media');
  await mkdir(media, { recursive: true });
  try {
    await run({ root, media });
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('photo-album-import-test-')) {
      throw new Error('Unexpected temporary test directory');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

async function photo(file, takenAt) {
  let pipeline = sharp({ create: { width: 64, height: 48, channels: 3, background: '#8b9aca' } });
  if (takenAt) pipeline = pipeline.withExif({ IFD2: { DateTimeOriginal: takenAt } });
  await (file.endsWith('.png') ? pipeline.png() : pipeline.jpeg()).toFile(file);
}

const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

test('camera-named files are numbered after the largest memory in shooting order', async () => {
  await fixture(async ({ media }) => {
    await writeFile(path.join(media, 'memory-002.JPG'), 'existing');
    await writeFile(path.join(media, 'memory-060.poster.jpg'), 'existing poster');
    await photo(path.join(media, 'DSC_0102.JPG'), '2024:08:02 09:20:00');
    await photo(path.join(media, 'DSC_0101.JPG'), '2024:08:02 09:14:00');
    await photo(path.join(media, '海边.png'));
    const video = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(projectRoot, 'public', 'demo', 'flower.mp4'),
      '-t', '1', '-c', 'copy', '-metadata', 'creation_time=2024-08-01T10:00:00.000000Z', path.join(media, 'DJI_0003.MP4')], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(video.status, 0, video.stderr);
    for (const file of ['IMG_1234.HEIC', 'C0001.MOV', 'DSC_0101.NEF', 'DJI_0003.SRT', '.gitkeep', 'Thumbs.db']) await writeFile(path.join(media, file), 'other');
    await mkdir(path.join(media, '云南'));
    const original = await digest(path.join(media, 'DSC_0101.JPG'));

    const preview = await importMedia(media, { dryRun: true });
    assert.deepEqual(preview.moves.map(({ file, to }) => [file, to]), [
      ['DJI_0003.MP4', 'memory-061.mp4'],
      ['DSC_0101.JPG', 'memory-062.jpg'],
      ['DSC_0102.JPG', 'memory-063.jpg'],
      ['海边.png', 'memory-064.png'],
    ]);
    assert.deepEqual(preview.moves.map(({ takenAt }) => takenAt), ['2024-08-01T10:00:00Z', '2024-08-02T09:14:00', '2024-08-02T09:20:00', undefined]);
    assert.deepEqual(preview.unsupported, [
      { file: 'C0001.MOV', convertTo: 'MP4' },
      { file: 'DSC_0101.NEF', convertTo: 'JPG' },
      { file: 'IMG_1234.HEIC', convertTo: 'JPG' },
    ]);
    assert.deepEqual(preview.others, ['DJI_0003.SRT']);
    assert.deepEqual(preview.folders, ['云南']);
    assert.deepEqual(preview.renamed, []);
    assert.ok((await readdir(media)).includes('DSC_0101.JPG'), 'a preview must not rename anything');

    const result = await importMedia(media);
    assert.deepEqual(result.renamed.map(({ to }) => to), ['memory-061.mp4', 'memory-062.jpg', 'memory-063.jpg', 'memory-064.png']);
    assert.deepEqual(result.failed, []);
    const files = await readdir(media);
    for (const file of ['DJI_0003.MP4', 'DSC_0101.JPG', 'DSC_0102.JPG', '海边.png']) assert.ok(!files.includes(file), `${file} must be renamed`);
    for (const file of ['memory-002.JPG', 'memory-060.poster.jpg', 'IMG_1234.HEIC', 'C0001.MOV', 'DSC_0101.NEF', 'DJI_0003.SRT']) assert.ok(files.includes(file), `${file} must stay`);
    assert.equal(await digest(path.join(media, 'memory-062.jpg')), original);
    const manifest = await scanMediaDirectory(media, { onWarning: () => {} });
    assert.deepEqual(manifest.items.map(({ index, type }) => [index, type]), [[2, 'image'], [61, 'video'], [62, 'image'], [63, 'image'], [64, 'image']]);
    assert.deepEqual((await importMedia(media)).moves, []);
  });
});

test('renaming never replaces an existing memory', async () => {
  await fixture(async ({ media }) => {
    await writeFile(path.join(media, 'new.jpg'), 'new');
    await writeFile(path.join(media, 'memory-001.jpg'), 'precious');
    await assert.rejects(moveWithoutOverwrite(path.join(media, 'new.jpg'), path.join(media, 'memory-001.jpg')), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(media, 'memory-001.jpg'), 'utf8'), 'precious');
    assert.equal(await readFile(path.join(media, 'new.jpg'), 'utf8'), 'new');
  });
});

test('the CLI previews the new names without changing any file', async () => {
  await fixture(async ({ root, media }) => {
    await photo(path.join(media, 'IMG_0001.jpg'), '2025:01:01 08:00:00');
    const run = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'media-import.mjs'), '--root', root, '--dry-run'], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /未改动任何文件/);
    assert.match(run.stdout, /IMG_0001\.jpg → memory-001\.jpg（2025-01-01 08:00）/);
    assert.deepEqual(await readdir(media), ['IMG_0001.jpg']);
  });
});
