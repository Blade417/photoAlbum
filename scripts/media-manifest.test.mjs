import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanMediaDirectory, createDemoManifest } from './media-manifest.mjs';

async function scanFiles(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'photo-album-test-'));
  const warnings = [];
  try {
    await Promise.all(files.map((file) => writeFile(path.join(directory, file), 'fixture')));
    const manifest = await scanMediaDirectory(directory, { onWarning: (warning) => warnings.push(warning) });
    return { manifest, warnings };
  } finally {
    // Only remove the exact dedicated directory returned by mkdtemp.
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('photo-album-test-')) {
      throw new Error('Unexpected temporary test directory');
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

test('mixed extensions, casing and gaps retain numeric ordering', async () => {
  const { manifest } = await scanFiles(['memory-042.mp4', 'memory-2.PNG', 'memory-009.jpeg', 'memory-17.webm', 'unrelated.jpg']);
  assert.equal(manifest.isDemo, false);
  assert.deepEqual(manifest.items.map((item) => [item.index, item.type]), [[2, 'image'], [9, 'image'], [17, 'video'], [42, 'video']]);
  assert.equal(manifest.items[0].src, 'media/memory-2.PNG');
  assert.equal(manifest.items[2].thumbnail, undefined);
});

test('a poster attaches to its video and is never an independent image', async () => {
  const { manifest } = await scanFiles(['memory-003.mp4', 'memory-3.poster.jpg', 'memory-088.poster.png']);
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].thumbnail, 'media/memory-3.poster.jpg');
});

test('duplicate resolution prefers padded names, then the documented extension order', async () => {
  const { manifest, warnings } = await scanFiles(['memory-1.mp4', 'memory-001.jpg', 'memory-002.png', 'memory-002.webm', 'memory-002.mp4']);
  assert.deepEqual(manifest.items.map((item) => item.src), ['media/memory-001.jpg', 'media/memory-002.mp4']);
  assert.equal(warnings.length, 2);
});

test('numbering starts at 1, has no 99-memory ceiling, and never fills missing slots', async () => {
  const { manifest, warnings } = await scanFiles(['memory-000.jpg', 'memory-001.avif', 'memory-099.ogg', 'memory-100.gif', 'memory-1200.webp', 'memory-23456.jpg']);
  assert.deepEqual(manifest.items.map((item) => item.index), [1, 99, 100, 1200, 23456]);
  assert.deepEqual(manifest.items.map((item) => item.id), ['memory-001', 'memory-099', 'memory-100', 'memory-1200', 'memory-23456']);
  assert.equal(manifest.capacity, undefined);
  assert.equal(warnings.length, 1);
});

test('canonical names win for numbers of any length', async () => {
  const { manifest, warnings } = await scanFiles(['memory-0100.jpg', 'memory-100.png', 'memory-01200.mp4', 'memory-1200.jpg', 'memory-7.jpg', 'memory-007.png']);
  assert.deepEqual(manifest.items.map((item) => item.src), ['media/memory-007.png', 'media/memory-100.png', 'media/memory-1200.jpg']);
  assert.equal(warnings.length, 3);
});

test('an empty directory provides 99 demo memories from a small shared local asset set', async () => {
  const { manifest } = await scanFiles(['README.md', 'memory-001.poster.jpg']);
  assert.deepEqual(manifest, createDemoManifest());
  assert.equal(manifest.items.length, 99);
  assert.equal(new Set(manifest.items.map((item) => item.id)).size, 99);
  assert.equal(manifest.items.filter((item) => item.type === 'video').length, 11);
  assert.ok(new Set(manifest.items.map((item) => item.src)).size <= 13);
  assert.ok(manifest.items.every((item) => item.demo));
  assert.ok(manifest.items.every((item) => /^#[0-9a-f]{6}$/.test(item.color) && item.takenAt === undefined));
});
