import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoScenes, demoVideo } from './demo-scenes.mjs';

export const MEDIA_CAPACITY = 99;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A video wins over a still image for the same canonical filename.
const extensions = ['mp4', 'webm', 'ogg', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];
const videoExtensions = new Set(['mp4', 'webm', 'ogg']);
const posterExtensions = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

export function createDemoManifest() {
  return {
    capacity: MEDIA_CAPACITY,
    isDemo: true,
    items: Array.from({ length: MEDIA_CAPACITY }, (_, offset) => {
      const index = offset + 1;
      const scene = demoScenes[offset % demoScenes.length];
      const video = index % 9 === 0;
      return {
        id: `memory-${String(index).padStart(3, '0')}`,
        index,
        type: video ? 'video' : 'image',
        src: `demo/${video ? demoVideo.file : scene.file}`,
        thumbnail: `demo/${video ? 'blossom.jpg' : scene.file}`,
        title: video ? demoVideo.title : scene.title,
        subtitle: video ? demoVideo.subtitle : scene.subtitle,
        demo: true,
      };
    }),
  };
}

export async function scanMediaDirectory(mediaDirectory, { onWarning = console.warn } = {}) {
  await mkdir(mediaDirectory, { recursive: true });
  const entries = await readdir(mediaDirectory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const candidates = new Map();

  for (const file of files) {
    const match = /^memory-(\d{1,3})\.(jpg|jpeg|png|webp|avif|gif|mp4|webm|ogg)$/i.exec(file);
    if (!match) continue;
    const index = Number(match[1]);
    if (index < 1 || index > MEDIA_CAPACITY) {
      onWarning(`[media] Ignored ${file}; supported indices are 1–${MEDIA_CAPACITY}.`);
      continue;
    }
    const list = candidates.get(index) ?? [];
    list.push({ file, index, padded: match[1].length === 3, extension: match[2].toLowerCase() });
    candidates.set(index, list);
  }

  if (candidates.size === 0) return createDemoManifest();

  const items = [...candidates.entries()].sort(([left], [right]) => left - right).map(([index, list]) => {
    list.sort((left, right) => Number(right.padded) - Number(left.padded)
      || extensions.indexOf(left.extension) - extensions.indexOf(right.extension)
      || left.file.localeCompare(right.file, 'en'));
    const selected = list[0];
    if (list.length > 1) {
      onWarning(`[media] Duplicate index ${index}: using ${selected.file}; ignored ${list.slice(1).map((item) => item.file).join(', ')}.`);
    }
    const type = videoExtensions.has(selected.extension) ? 'video' : 'image';
    const poster = files
      .map((file) => ({ file, match: /^memory-(\d{1,3})\.poster\.(jpg|jpeg|png|webp|avif)$/i.exec(file) }))
      .filter(({ match }) => match && Number(match[1]) === index)
      .sort((left, right) => Number(right.match[1].length === 3) - Number(left.match[1].length === 3)
        || posterExtensions.indexOf(left.match[2].toLowerCase()) - posterExtensions.indexOf(right.match[2].toLowerCase())
        || left.file.localeCompare(right.file, 'en'))[0]?.file;
    const src = `media/${encodeURIComponent(selected.file)}`;
    return {
      id: `memory-${String(index).padStart(3, '0')}`,
      index,
      type,
      src,
      ...(type === 'image' ? { thumbnail: src } : poster ? { thumbnail: `media/${encodeURIComponent(poster)}` } : {}),
      title: `回忆 ${String(index).padStart(3, '0')}`,
      subtitle: type === 'video' ? '动态回忆 · 点击播放' : '光影留存 · 点击探索',
    };
  });

  return { items, isDemo: false, capacity: MEDIA_CAPACITY };
}

export async function generateMediaManifest(root = projectRoot, options) {
  const manifest = await scanMediaDirectory(path.join(root, 'public', 'media'), options);
  const destination = path.join(root, 'public', 'media-manifest.json');
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const previous = await readFile(destination, 'utf8').catch(() => '');
  if (previous !== content) await writeFile(destination, content, 'utf8');
  return manifest;
}

export function mediaManifestPlugin() {
  let root = projectRoot;
  let pendingUpdate;
  return {
    name: 'memory-media-manifest',
    configResolved(config) { root = config.root; },
    async buildStart() { await generateMediaManifest(root); },
    async configureServer(server) {
      await generateMediaManifest(root);
      const mediaDirectory = path.resolve(root, 'public', 'media');
      server.watcher.add(mediaDirectory);
      const onFileChange = (_event, file) => {
        const relative = path.relative(mediaDirectory, path.resolve(file));
        if (relative.startsWith('..') || path.isAbsolute(relative)) return;
        clearTimeout(pendingUpdate);
        pendingUpdate = setTimeout(async () => {
          try {
            await generateMediaManifest(root);
            server.ws.send({ type: 'full-reload', path: '*' });
          } catch (error) {
            server.config.logger.error(`[media] Cannot refresh media manifest: ${error.message}`);
          }
        }, 200);
      };
      server.watcher.on('all', onFileChange);
      server.httpServer?.once('close', () => {
        clearTimeout(pendingUpdate);
        server.watcher.off('all', onFileChange);
      });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await generateMediaManifest();
  console.log(`[media] ${manifest.items.length} ${manifest.isDemo ? 'demo' : 'local'} memories; capacity ${manifest.capacity}.`);
}
