import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONTENT, SITE_LIMITS, validateContent } from '../shared/album-content.mjs';
import { createContentMiddleware, contentStorePlugin, initializeContentFile, MAX_CONTENT_BYTES, saveContentFile } from './content-store.mjs';

async function fixture(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'photo-album-content-test-'));
  const filename = path.join(directory, 'album-content.json');
  let server;
  try {
    await saveContentFile(filename, DEFAULT_CONTENT);
    const middleware = createContentMiddleware({ filename: options.filename?.(directory) ?? filename, base: options.base ?? '/' });
    server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const send = ({ method = 'GET', route = `${options.base ?? '/'}__album/content`, headers = {}, value, raw, chunked = false } = {}) => new Promise((resolve, reject) => {
      const body = raw ?? (value === undefined ? undefined : JSON.stringify(value));
      const requestHeaders = {
        ...(method === 'PUT' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
        ...(chunked ? { 'Transfer-Encoding': 'chunked' } : {}), ...headers,
      };
      const req = request({ hostname: '127.0.0.1', port, path: route, method, headers: Object.fromEntries(Object.entries(requestHeaders).filter(([, value]) => value !== undefined)) }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      if (chunked && body) { req.write(body.slice(0, 1024)); req.end(body.slice(1024)); }
      else req.end(body);
    });
    await run({ directory, filename, send, origin, port });
  } finally {
    if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('photo-album-content-test-')) throw new Error('Unexpected temporary test directory');
    await rm(resolved, { recursive: true, force: true });
  }
}

test('shared defaults validate to an independent copy and accept intentional empty captions', () => {
  const copy = validateContent(DEFAULT_CONTENT);
  copy.site.name = '我的星空';
  copy.memories.personal['memory-099'] = { title: '', subtitle: '' };
  assert.equal(DEFAULT_CONTENT.site.name, '星屿');
  assert.deepEqual(validateContent(copy), copy);
});

test('clean checkout initialization creates missing directories and defaults without racing other initializers', async () => {
  await fixture(async ({ directory }) => {
    const filename = path.join(directory, 'public', 'album-content.json');
    const created = await Promise.all(Array.from({ length: 4 }, () => initializeContentFile(filename)));
    assert.equal(created.filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), DEFAULT_CONTENT);
  });
});

test('initialization preserves customized and malformed content byte for byte', async () => {
  await fixture(async ({ filename }) => {
    const custom = validateContent(DEFAULT_CONTENT);
    custom.site.name = '我的回忆';
    custom.memories.personal['memory-001'] = { title: '我们的旅行', subtitle: '原始文案' };
    for (const content of [`${JSON.stringify(custom, null, '\t')}\r\n`, '{ "unfinished": ', '']) {
      await writeFile(filename, content);
      const before = await readFile(filename);
      assert.equal(await initializeContentFile(filename), false);
      assert.deepEqual(await readFile(filename), before);
    }
  });
});

test('schema rejects invalid versions, unknown keys, prototypes, boundaries and overlong text', () => {
  const cases = [
    (c) => { c.version = 2; },
    (c) => { c.extra = true; },
    (c) => { delete c.site.name; },
    (c) => { c.site.name = '  '; },
    (c) => { c.site.name = 'x'.repeat(SITE_LIMITS.name + 1); },
    (c) => { c.site.description = '\u0000'; },
    (c) => { c.memories.demo['memory-000'] = { title: '', subtitle: '' }; },
    (c) => { c.memories.personal['memory-100'] = { title: '', subtitle: '' }; },
    (c) => { c.memories.personal['memory-1'] = { title: '', subtitle: '' }; },
    (c) => { c.memories.personal['memory-001'] = { title: 'x'.repeat(81), subtitle: '' }; },
    (c) => { c.memories.personal['memory-001'] = { title: '', subtitle: 'x'.repeat(241) }; },
    (c) => { c.memories.personal['memory-001'] = { title: '', subtitle: '', src: 'file.txt' }; },
    (c) => { c.memories.personal.constructor = { title: '', subtitle: '' }; },
    (c) => { c.memories.personal = JSON.parse('{"__proto__":{"title":"bad","subtitle":"bad"}}'); },
    (c) => { c.site = Object.assign(Object.create({ inherited: 'value' }), c.site); },
    (c) => { c.memories.demo = []; },
  ];
  for (const mutate of cases) { const content = validateContent(DEFAULT_CONTENT); mutate(content); assert.throws(() => validateContent(content)); }
  assert.equal({}.polluted, undefined);
});

test('atomic saves replace complete documents, preserve valid data after rejected edits, and clean temporary files', async () => {
  await fixture(async ({ filename, directory }) => {
    const content = validateContent(DEFAULT_CONTENT);
    content.site.name = '家庭相册';
    content.memories.personal['memory-001'] = { title: '生日', subtitle: '一起吹蜡烛' };
    await saveContentFile(filename, content);
    await assert.rejects(saveContentFile(filename, { ...content, version: 2 }));
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), content);
    await Promise.all(Array.from({ length: 6 }, (_, i) => saveContentFile(filename, { ...content, site: { ...content.site, name: `相册${i}` } })));
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    assert.doesNotThrow(() => validateContent(saved));
    assert.deepEqual(await readdir(directory), ['album-content.json']);
  });
});

test('local API loads and saves with a base path while keeping demo and personal captions separate', async () => {
  await fixture(async ({ send, filename }) => {
    const first = await send();
    assert.equal(first.status, 200);
    assert.equal(first.body.writable, true);
    assert.equal(first.headers['cache-control'], 'no-store');
    const content = first.body.content;
    content.memories.demo['memory-001'] = { title: '演示', subtitle: '' };
    content.memories.personal['memory-001'] = { title: '我的照片', subtitle: '个人说明' };
    const saved = await send({ method: 'PUT', value: content });
    assert.deepEqual(saved.body, { ok: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), content);
    assert.equal((await send({ route: '/__album/content' })).status, 404);
  }, { base: '/photos/' });
});

test('malformed project files return defaults with a warning and can be repaired', async () => {
  await fixture(async ({ send, filename }) => {
    await writeFile(filename, '{ bad JSON');
    const loaded = await send();
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.writable, true);
    assert.ok(loaded.body.warning);
    assert.deepEqual(loaded.body.content, DEFAULT_CONTENT);
    assert.equal((await send({ method: 'PUT', value: loaded.body.content })).status, 200);
    assert.equal((await send()).body.warning, undefined);
  });
});

test('API rejects cross-origin, LAN and hostile Host requests without changing the file', async () => {
  await fixture(async ({ send, filename, origin, port }) => {
    for (const headers of [
      { Origin: 'https://malicious.example' },
      { Origin: 'null' },
      { Origin: `${origin}/` },
      { Origin: 'http://127.0.0.1:1' },
      { Origin: '' },
      { Host: `192.168.1.10:${port}`, Origin: `http://192.168.1.10:${port}` },
      { Host: `localhost.malicious.example:${port}`, Origin: `http://localhost.malicious.example:${port}` },
      { Host: `malicious.example:${port}`, Origin: `http://malicious.example:${port}` },
      { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      assert.equal((await send({ method: 'PUT', value: DEFAULT_CONTENT, headers })).status, 403);
    }
    assert.equal((await send({ headers: { Origin: 'http://other.example' } })).status, 403);
    assert.equal((await send({ method: 'PUT', value: DEFAULT_CONTENT, headers: { Origin: undefined } })).status, 403);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), DEFAULT_CONTENT);
  });
});

test('API rejects invalid JSON, schema, content type, oversized fixed and chunked bodies', async () => {
  await fixture(async ({ send, filename }) => {
    assert.equal((await send({ method: 'PUT', raw: '{' })).status, 400);
    assert.equal((await send({ method: 'PUT', value: { ...DEFAULT_CONTENT, version: 2 } })).status, 400);
    assert.equal((await send({ method: 'PUT', value: DEFAULT_CONTENT, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const tooLarge = JSON.stringify({ overflow: 'x'.repeat(MAX_CONTENT_BYTES) });
    assert.equal((await send({ method: 'PUT', raw: tooLarge })).status, 413);
    assert.equal((await send({ method: 'PUT', raw: tooLarge, chunked: true })).status, 413);
    assert.equal((await send({ method: 'DELETE' })).status, 405);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), DEFAULT_CONTENT);
  });
});

test('filesystem failures are explicit errors instead of claiming a successful save', async () => {
  await fixture(async ({ directory, send }) => {
    await writeFile(path.join(directory, 'blocked'), 'not a directory');
    const result = await send({ method: 'PUT', value: DEFAULT_CONTENT });
    assert.equal(result.status, 500);
    assert.ok(result.body.error);
    assert.notEqual(result.body.ok, true);
  }, { filename: (directory) => path.join(directory, 'blocked', 'album-content.json') });
});

test('plugin creates defaults before dev/build and ignores editor saves without overwriting existing files', async () => {
  await fixture(async ({ directory: root }) => {
    const plugin = contentStorePlugin();
    const publicDir = path.join(root, 'public');
    const filename = path.join(publicDir, 'album-content.json');
    const ignore = plugin.config().server.watch.ignored[0];
    await plugin.configResolved({ root, publicDir, base: '/' });
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), DEFAULT_CONTENT);
    assert.equal(ignore(filename), true);
    assert.equal(ignore(path.join(publicDir, '.album-content.json.random.tmp')), true);
    assert.equal(ignore(path.join(publicDir, 'media', 'memory-001.jpg')), false);
    assert.equal(ignore(path.join(root, 'src', 'App.tsx')), false);
    const existing = Buffer.from('{ "user edit in progress" ');
    await writeFile(filename, existing);
    await plugin.configResolved({ root, publicDir, base: '/' });
    assert.deepEqual(await readFile(filename), existing);
  });
});
