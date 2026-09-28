import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTENT, validateContent } from '../shared/album-content.mjs';

export const MAX_CONTENT_BYTES = 1024 * 1024;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pendingWrites = new Map();

async function replaceFile(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      // Antivirus/indexing can briefly hold a Windows file; never unlink the valid destination.
      await delay(20 * (attempt + 1));
    }
  }
}

export async function saveContentFile(filename, value) {
  const content = validateContent(value);
  const destination = path.resolve(filename);
  // Serialize writes from multiple tabs; Windows may reject simultaneous replacement renames.
  const write = (pendingWrites.get(destination) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const directory = path.dirname(destination);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await replaceFile(temporary, destination);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  });
  pendingWrites.set(destination, write);
  try { await write; }
  finally { if (pendingWrites.get(destination) === write) pendingWrites.delete(destination); }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function isLocalRequest(request) {
  const host = request.headers.host;
  const remote = request.socket.remoteAddress;
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  try {
    const protocol = request.socket.encrypted ? 'https:' : 'http:';
    const target = new URL(`${protocol}//${host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase())) return false;
    const origin = request.headers.origin;
    if (origin !== undefined && (typeof origin !== 'string' || new URL(origin).origin !== origin || origin !== target.origin)) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    // PUT is a browser write: require Origin instead of trusting an arbitrary localhost URL.
    return request.method !== 'PUT' || typeof origin === 'string';
  } catch { return false; }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted);
    };
    const fail = (message, status) => { cleanup(); request.resume(); reject(Object.assign(new Error(message), { status })); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_CONTENT_BYTES) { fail('文案配置不能超过 1 MB。', 413); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const onError = () => fail('无法读取请求内容。', 400);
    const onAborted = () => fail('保存请求已中断。', 400);
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError); request.on('aborted', onAborted);
  });
}

export function createContentMiddleware({ filename, base = '/' }) {
  const normalizedBase = base === './' || base === '' ? '/' : `/${base.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const endpoint = `${normalizedBase}__album/content`;
  return async (request, response, next) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { return next(); }
    if (pathname !== endpoint) return next();
    if (!isLocalRequest(request)) { json(response, 403, { error: '只有同源的本机开发页面可以读写工程文案。' }); return; }
    if (request.method === 'GET') {
      try {
        const content = validateContent(JSON.parse(await readFile(filename, 'utf8')));
        json(response, 200, { content, writable: true });
      } catch {
        json(response, 200, { content: DEFAULT_CONTENT, writable: true, warning: 'album-content.json 无法读取或格式错误，已使用默认文案；保存后可修复工程文件。' });
      }
      return;
    }
    if (request.method !== 'PUT') { response.setHeader('Allow', 'GET, PUT'); json(response, 405, { error: '此接口只支持 GET 和 PUT。' }); return; }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) { json(response, 415, { error: '请使用 application/json 提交文案。' }); request.resume(); return; }
    if (Number(request.headers['content-length']) > MAX_CONTENT_BYTES) { json(response, 413, { error: '文案配置不能超过 1 MB。' }); request.resume(); return; }
    let content;
    try { content = validateContent(JSON.parse(await readBody(request))); }
    catch (error) { if (!response.destroyed) json(response, error.status ?? 400, { error: error instanceof SyntaxError ? '文案配置不是有效的 JSON。' : error.message }); return; }
    try { await saveContentFile(filename, content); json(response, 200, { ok: true }); }
    catch { json(response, 500, { error: '无法写入工程文案文件，请检查文件权限和磁盘空间。' }); }
  };
}

export function contentStorePlugin() {
  let filename = path.join(projectRoot, 'public', 'album-content.json');
  let base = '/';
  return {
    name: 'album-content-store',
    config() {
      // Vite watches public files before handleHotUpdate, so ignore this file at the watcher.
      // The editor updates React after saving; an automatic page reload would discard its state.
      return { server: { watch: { ignored: [(file) => {
        const resolved = path.resolve(file);
        return resolved === filename || (path.dirname(resolved) === path.dirname(filename)
          && path.basename(resolved).startsWith(`.${path.basename(filename)}.`) && resolved.endsWith('.tmp'));
      }] } } };
    },
    configResolved(config) { filename = path.join(config.publicDir || path.join(config.root, 'public'), 'album-content.json'); base = config.base; },
    configureServer(server) { server.middlewares.use(createContentMiddleware({ filename, base })); },
  };
}
