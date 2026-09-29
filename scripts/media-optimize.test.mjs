import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { generateMediaManifest, mediaManifestPlugin } from './media-manifest.mjs';
import { normalizeCaptureTime } from './media-optimize.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'photo-album-preview-test-'));
  const media = path.join(root, 'public', 'media');
  await mkdir(media, { recursive: true });
  const warnings = [];
  const summaries = [];
  const options = { onWarning: (message) => warnings.push(message), onProgress: () => {}, onSummary: (summary) => summaries.push(summary) };
  try {
    await run({ root, media, warnings, summaries, options, absolute: (url) => path.join(root, 'public', url) });
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('photo-album-preview-test-')) {
      throw new Error('Unexpected temporary test directory');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

async function image(file, width = 2400, height = 1600, colour = '#8b9aca', orientation) {
  let pipeline = sharp({ create: { width, height, channels: 3, background: colour } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  await pipeline.jpeg({ quality: 94 }).toFile(file);
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

test('previews resize and orient photos, remove metadata, and leave originals unchanged', async () => {
  await fixture(async ({ root, media, options, absolute }) => {
    const source = path.join(media, 'memory-001.jpg');
    await image(source, 3000, 1800, '#8b9aca', 6);
    const originalDigest = await digest(source);
    const manifest = await generateMediaManifest(root, options);
    const item = manifest.items[0];
    assert.equal(item.src, 'media/memory-001.jpg');
    for (const [key, limit] of [['thumbnail', 384], ['previewSrc', 768], ['displaySrc', 2048]]) {
      assert.match(item[key], /^media-previews\/memory-001-[a-f0-9]{20}-.*\.webp$/);
      const metadata = await sharp(absolute(item[key])).metadata();
      assert.equal(metadata.format, 'webp');
      assert.ok(Math.max(metadata.width, metadata.height) <= limit);
      assert.ok(metadata.width < metadata.height, 'EXIF rotation must be applied before resize');
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.orientation, undefined);
      if (key === 'previewSrc') assert.equal(item.aspect, metadata.width / metadata.height);
    }
    assert.equal(await digest(source), originalDigest);
  });
});

test('cache reuses existing previews, repairs missing/truncated outputs, and invalidates replaced inputs', async () => {
  await fixture(async ({ root, media, options, summaries, absolute }) => {
    const source = path.join(media, 'memory-001.jpg');
    await image(source, 1200, 800);
    const first = (await generateMediaManifest(root, options)).items[0];
    const firstStat = await stat(absolute(first.previewSrc), { bigint: true });
    const second = (await generateMediaManifest(root, options)).items[0];
    assert.deepEqual(second, first);
    assert.equal((await stat(absolute(first.previewSrc), { bigint: true })).mtimeNs, firstStat.mtimeNs);
    assert.deepEqual(summaries.at(-1), { created: 0, cached: 1, failed: 0 });

    await writeFile(absolute(first.previewSrc), 'truncated');
    await rm(absolute(first.thumbnail));
    const repaired = (await generateMediaManifest(root, options)).items[0];
    assert.deepEqual(repaired, first);
    assert.equal((await sharp(absolute(first.previewSrc)).metadata()).format, 'webp');
    assert.deepEqual(summaries.at(-1), { created: 1, cached: 0, failed: 0 });

    await image(source, 800, 1200, '#ed6b78');
    const replacement = (await generateMediaManifest(root, options)).items[0];
    assert.notEqual(replacement.previewSrc, first.previewSrc);
    assert.equal(replacement.src, first.src);
    assert.ok(replacement.aspect < 1);
    assert.equal(JSON.parse(await readFile(path.join(root, 'public', 'media-manifest.json'), 'utf8')).items[0].previewSrc, replacement.previewSrc);
  });
});

test('small photos are not upscaled and GIF details retain the original animated file', async () => {
  await fixture(async ({ root, media, options, absolute }) => {
    await image(path.join(media, 'memory-001.jpg'), 40, 24);
    await sharp({ create: { width: 48, height: 32, channels: 4, background: '#abcdef' } }).gif().toFile(path.join(media, 'memory-002.gif'));
    const { items } = await generateMediaManifest(root, options);
    for (const key of ['thumbnail', 'previewSrc', 'displaySrc']) {
      const metadata = await sharp(absolute(items[0][key])).metadata();
      assert.deepEqual([metadata.width, metadata.height], [40, 24]);
    }
    assert.equal(items[1].displaySrc, items[1].src);
    assert.match(items[1].previewSrc, /\.webp$/);
  });
});

test('FFmpeg produces a bounded silent 24fps video preview with a generated poster', async () => {
  await fixture(async ({ root, media, options, absolute, warnings }) => {
    const source = path.join(media, 'memory-009.mp4');
    const seed = path.join(projectRoot, 'public', 'demo', 'flower.mp4');
    const makeLonger = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '2', '-i', seed, '-t', '13', '-c', 'copy', source], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(makeLonger.status, 0, makeLonger.stderr);
    const originalDigest = await digest(source);
    const item = (await generateMediaManifest(root, options)).items[0];
    assert.deepEqual(warnings, []);
    assert.equal(item.src, 'media/memory-009.mp4');
    assert.match(item.previewSrc, /-preview\.mp4$/);
    assert.equal(item.displaySrc, undefined);
    assert.ok(Math.abs(item.aspect - 16 / 9) < 0.01);
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', absolute(item.previewSrc), '-f', 'null', '-'], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stderr, /Video: h264/);
    assert.match(probe.stderr, /640x360/);
    assert.match(probe.stderr, /24 fps/);
    assert.doesNotMatch(probe.stderr, /Audio:/);
    assert.match(probe.stderr, /Duration: 00:00:12\.00/);
    const poster = await sharp(absolute(item.thumbnail)).metadata();
    assert.equal(poster.format, 'webp');
    assert.ok(poster.width <= 384 && poster.height <= 384);
    assert.ok((await stat(absolute(item.previewSrc))).size < (await stat(source)).size / 2);
    assert.equal(await digest(source), originalDigest);
  });
});

test('capture times keep the recorded wall clock and reject unset or impossible values', () => {
  assert.equal(normalizeCaptureTime('2023-06-01T16:30:00+0800'), '2023-06-01T16:30:00+08:00');
  assert.equal(normalizeCaptureTime('2023-06-01T08:30:00.000000Z'), '2023-06-01T08:30:00Z');
  assert.equal(normalizeCaptureTime('2023-06-01T16:30:00'), '2023-06-01T16:30:00');
  assert.equal(normalizeCaptureTime('1970-01-01T00:00:00.000000Z', 1971), undefined);
  assert.equal(normalizeCaptureTime('1904-01-01T00:00:00Z', 1971), undefined);
  assert.equal(normalizeCaptureTime('2023-02-30T10:00:00'), undefined);
  assert.equal(normalizeCaptureTime('2023-06-01T24:00:00'), undefined);
  assert.equal(normalizeCaptureTime(`${new Date().getFullYear() + 2}-01-01T00:00:00`), undefined);
  assert.equal(normalizeCaptureTime('not a date'), undefined);
});

test('photo EXIF, video metadata and preview colours are read once and cached', async () => {
  await fixture(async ({ root, media, options, summaries, warnings }) => {
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c86432' } })
      .withExif({ IFD2: { DateTimeOriginal: '2023:06:01 16:30:00', OffsetTimeOriginal: '+08:00' } })
      .jpeg().toFile(path.join(media, 'memory-001.jpg'));
    await sharp({ create: { width: 320, height: 240, channels: 3, background: '#2d6cb4' } })
      .withExif({ IFD2: { DateTimeOriginal: '2021:12:24 20:05:09' } })
      .jpeg().toFile(path.join(media, 'memory-002.jpg'));
    await image(path.join(media, 'memory-003.jpg'), 200, 120, '#808080');
    const tagged = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(projectRoot, 'public', 'demo', 'flower.mp4'),
      '-t', '1', '-c', 'copy', '-metadata', 'creation_time=2019-08-15T02:03:04.000000Z', path.join(media, 'memory-120.mp4')], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(tagged.status, 0, tagged.stderr);
    const { items } = await generateMediaManifest(root, options);
    assert.deepEqual(warnings, []);
    assert.deepEqual(items.map((item) => item.id), ['memory-001', 'memory-002', 'memory-003', 'memory-120']);
    assert.deepEqual(items.map((item) => item.takenAt), ['2023-06-01T16:30:00+08:00', '2021-12-24T20:05:09', undefined, '2019-08-15T02:03:04Z']);
    const channel = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16);
    const near = (hex, expected) => [1, 3, 5].every((offset) => Math.abs(channel(hex, offset) - channel(expected, offset)) <= 16);
    assert.ok(near(items[0].color, '#c86432'), items[0].color);
    assert.ok(near(items[1].color, '#2d6cb4'), items[1].color);
    assert.ok(items.every((item) => /^#[0-9a-f]{6}$/.test(item.color)));

    // Details from an older metadata version are re-read without re-encoding previews.
    const cachePath = path.join(root, 'public', 'media-previews', '.cache.json');
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.ok(Object.values(cache.entries).every((entry) => entry.details.version === 1));
    for (const entry of Object.values(cache.entries)) delete entry.details;
    await writeFile(cachePath, JSON.stringify(cache));
    assert.deepEqual((await generateMediaManifest(root, options)).items, items);
    assert.deepEqual(summaries.at(-1), { created: 0, cached: 4, failed: 0 });
  });
});

test('invalid sources fall back without poisoning the cache and recover on the next scan', async () => {
  await fixture(async ({ root, media, options, warnings, summaries }) => {
    const source = path.join(media, 'memory-001.jpg');
    await writeFile(source, 'file copy is incomplete');
    await copyFile(path.join(projectRoot, 'public', 'demo', 'alpine.jpg'), path.join(media, 'memory-002.jpg'));
    const items = (await generateMediaManifest(root, options)).items;
    assert.equal(items[0].previewSrc, undefined);
    assert.ok(items[1].previewSrc);
    assert.equal(warnings.length, 1);
    assert.deepEqual(summaries.at(-1), { created: 1, cached: 0, failed: 1 });
    const cache = JSON.parse(await readFile(path.join(root, 'public', 'media-previews', '.cache.json'), 'utf8'));
    assert.equal(cache.entries['memory-001'], undefined);
    await image(source, 200, 160);
    assert.ok((await generateMediaManifest(root, options)).items[0].previewSrc);
    assert.deepEqual(summaries.at(-1), { created: 1, cached: 1, failed: 0 });
  });
});

test('overlapping generation requests serialize and publish complete, consistent manifests', async () => {
  await fixture(async ({ root, media, options, summaries }) => {
    await image(path.join(media, 'memory-001.jpg'));
    const results = await Promise.all([generateMediaManifest(root, options), generateMediaManifest(root, options), generateMediaManifest(root, options)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.deepEqual(summaries.map((summary) => summary.created), [1, 0, 0]);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'public', 'media-manifest.json'), 'utf8')), results[2]);
  });
});

test('Vite serves newly generated previews and performs one completed refresh without a reload loop', async () => {
  await fixture(async ({ root, media, absolute }) => {
    const { createServer } = await import('vite');
    await image(path.join(media, 'memory-001.jpg'), 240, 160);
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><body>Preview fixture</body></html>');
    const server = await createServer({
      root, configFile: false, logLevel: 'error', plugins: [mediaManifestPlugin()],
      server: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    const reloads = [];
    const send = server.ws.send.bind(server.ws);
    server.ws.send = (payload, ...rest) => {
      if (payload?.type === 'full-reload') reloads.push(payload);
      return send(payload, ...rest);
    };
    try {
      await server.listen();
      const address = server.httpServer.address();
      const base = `http://127.0.0.1:${address.port}`;
      await fetch(base).then((response) => response.text());
      await image(path.join(media, 'memory-002.jpg'), 160, 240);
      const deadline = Date.now() + 10000;
      let added;
      while (Date.now() < deadline && !added) {
        const manifest = JSON.parse(await readFile(absolute('media-manifest.json'), 'utf8'));
        added = manifest.items.find((item) => item.index === 2 && item.previewSrc);
        if (!added) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(added, 'the source watcher must publish optimized new media');
      const response = await fetch(`${base}/${added.previewSrc}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /image\/webp/);
      assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, 'webp');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(reloads.length, 1, 'derived files must not trigger repeated full reloads');
    } finally {
      await server.close();
    }
  });
});

test('the standalone optimize CLI generates a complete manifest without a module-import deadlock', async () => {
  await fixture(async ({ root, media, absolute }) => {
    await image(path.join(media, 'memory-001.jpg'), 120, 80);
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'media-optimize.mjs'), '--root', root], {
      windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 local memories ready/);
    const manifest = JSON.parse(await readFile(absolute('media-manifest.json'), 'utf8'));
    assert.ok(manifest.items[0].previewSrc);
    assert.ok((await stat(absolute(manifest.items[0].previewSrc))).size > 0);
  });
});
