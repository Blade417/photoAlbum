import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import bundledFfmpeg from 'ffmpeg-static';
import exifReader from 'exif-reader';

// Vips otherwise retains source/output handles in its operation cache on Windows,
// preventing atomic replacement and keeping deleted or replaced inputs alive.
sharp.cache(false);

export const PREVIEW_VERSION = 1;
// Bumping this re-reads capture details without re-encoding cached previews.
export const METADATA_VERSION = 1;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pendingOptimizations = new Map();

async function renameCompleteFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      // Windows readers and antivirus can hold a brief sharing lock. Keep the
      // previous complete file in place and retry; never delete it as a shortcut.
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

// Use a new file on the same filesystem, so readers see either the old or complete new file.
export async function atomicWriteIfChanged(destination, content) {
  if (await readFile(destination, 'utf8').catch(() => '') === content) return false;
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await renameCompleteFile(temporary, destination);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

function sourcePath(publicDirectory, source) {
  const relative = decodeURIComponent(source);
  const result = path.resolve(publicDirectory, relative);
  const mediaDirectory = path.join(publicDirectory, 'media');
  if (path.dirname(result) !== mediaDirectory) throw new Error('Source must be a file in public/media');
  return result;
}

async function describeInput(file) {
  const info = await stat(file, { bigint: true });
  if (!info.isFile()) throw new Error('Media source is not a regular file');
  return { size: info.size.toString(), modified: info.mtimeNs.toString() };
}

async function inputSignature(item, publicDirectory) {
  const source = sourcePath(publicDirectory, item.src);
  const poster = item.type === 'video' && item.thumbnail
    ? sourcePath(publicDirectory, item.thumbnail) : undefined;
  return {
    version: PREVIEW_VERSION,
    type: item.type,
    source: { path: item.src, ...await describeInput(source) },
    ...(poster ? { poster: { path: item.thumbnail, ...await describeInput(poster) } } : {}),
  };
}

async function validCachedEntry(entry, expected, outputDirectory) {
  if (!entry || entry.fingerprint !== expected.fingerprint || !Array.isArray(entry.files)
    || !Number.isFinite(entry.aspect) || entry.aspect <= 0) return false;
  const expectedNames = Object.values(expected.outputs);
  if (entry.files.length !== expectedNames.length) return false;
  for (const name of expectedNames) {
    const cached = entry.files.find((file) => file.name === name);
    if (!cached || !Number.isSafeInteger(cached.size) || cached.size <= 0) return false;
    const current = await stat(path.join(outputDirectory, name)).catch(() => null);
    if (!current?.isFile() || current.size !== cached.size) return false;
  }
  return true;
}

function runFfmpeg(args, ffmpegPath = process.env.FFMPEG_PATH || bundledFfmpeg, { captureOutput = false } = {}) {
  if (!ffmpegPath) return Promise.reject(new Error('FFmpeg is unavailable; set FFMPEG_PATH to its executable'));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      windowsHide: true,
      stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'],
    });
    let details = '';
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 5 * 60 * 1000);
    child.stdout?.on('data', (chunk) => { if (output.length < 65536) output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { details = (details + chunk.toString()).slice(-8000); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error(timedOut ? 'Video preview generation timed out' : details.trim() || `FFmpeg exited with code ${code}`));
    });
  });
}

const CAPTURE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// Keep the wall-clock time where the memory happened; a zone is kept only when recorded.
export function normalizeCaptureTime(value, earliestYear = 1900) {
  const match = typeof value === 'string' ? CAPTURE_TIME.exec(value.trim()) : null;
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < earliestYear || year > new Date().getFullYear() + 1 || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return undefined;
  const zone = !match[7] ? '' : match[7] === 'Z' ? 'Z' : `${match[7].slice(0, 3)}:${match[7].slice(-2)}`;
  return `${match.slice(1, 4).join('-')}T${match.slice(4, 7).join(':')}${zone}`;
}

function imageCaptureTime(metadata) {
  if (!metadata?.exif) return undefined;
  let tags;
  try { tags = exifReader(metadata.exif); } catch { return undefined; }
  // exif-reader returns the camera's local wall-clock time as a UTC Date.
  // DateTime (IFD0) is skipped: editors rewrite it to the export time.
  for (const [date, offset] of [
    [tags.Photo?.DateTimeOriginal, tags.Photo?.OffsetTimeOriginal],
    [tags.Photo?.DateTimeDigitized, tags.Photo?.OffsetTimeDigitized],
  ]) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) continue;
    const zone = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '';
    const value = normalizeCaptureTime(`${date.toISOString().slice(0, 19)}${zone}`);
    if (value) return value;
  }
  return undefined;
}

async function videoCaptureTime(source, options) {
  const output = await runFfmpeg(['-i', source, '-map_metadata', '0', '-f', 'ffmetadata', '-'], options.ffmpegPath, { captureOutput: true });
  const tags = new Map(output.split(/\r?\n/).map((line) => line.split(/=(.*)/s, 2)).filter((pair) => pair.length === 2));
  // Apple records local time with its offset; creation_time is UTC. Zero epochs mean "unset".
  for (const key of ['com.apple.quicktime.creationdate', 'creation_time']) {
    const value = normalizeCaptureTime(tags.get(key), 1971);
    if (value) return value;
  }
  return undefined;
}

export async function readCaptureTime(file, type, options = {}) {
  return type === 'image' ? imageCaptureTime(await sharp(file).metadata()) : videoCaptureTime(file, options);
}

export async function memoryColor(file) {
  const { dominant, channels } = await sharp(file).stats();
  const [red, green = red, blue = red] = channels.map((channel) => channel.mean);
  const luminance = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Dominant bins are vivid for most photos; very dark or blown-out frames use their mean.
  const colour = luminance(dominant) >= 40 && luminance(dominant) <= 235 ? dominant : { r: red, g: green, b: blue };
  return `#${[colour.r, colour.g, colour.b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

async function describeMemory(item, source, thumbnail, sourceMetadata, options) {
  const details = {};
  try {
    const takenAt = item.type === 'image' ? imageCaptureTime(sourceMetadata) : await videoCaptureTime(source, options);
    if (takenAt) details.takenAt = takenAt;
    details.color = await memoryColor(thumbnail);
    return { version: METADATA_VERSION, ...details };
  } catch (error) {
    // Details are optional; leaving out the version retries them on the next scan.
    (options.onWarning ?? console.warn)(`[media] ${item.id}: capture details unavailable. ${error.message}`);
    return details;
  }
}

async function writeWebp(source, destination, edge, quality) {
  // The default first-frame decode keeps animated sources cheap in the 3D scene.
  // Sharp strips EXIF/GPS metadata unless explicitly asked to retain it.
  await sharp(source).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality }).toFile(destination);
}

async function createPreviews(item, inputs, outputs, publicDirectory, outputDirectory, options) {
  const source = sourcePath(publicDirectory, item.src);
  const temporary = Object.fromEntries(Object.entries(outputs).map(([key, name]) => [key,
    path.join(outputDirectory, `.${process.pid}-${randomUUID()}-${name}`),
  ]));
  const scratchFrame = path.join(outputDirectory, `.${process.pid}-${randomUUID()}-frame.png`);
  try {
    if (item.type === 'image') {
      await writeWebp(source, temporary.thumbnail, 384, 72);
      await writeWebp(source, temporary.previewSrc, 768, 78);
      if (temporary.displaySrc) await writeWebp(source, temporary.displaySrc, 2048, 85);
    } else {
      await runFfmpeg([
        '-threads', '2', '-filter_threads', '1', '-i', source,
        '-map', '0:v:0', '-t', '12', '-an', '-sn', '-dn',
        '-vf', "fps=24,scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
        '-threads', '2', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart',
        '-f', 'mp4', temporary.previewSrc,
      ], options.ffmpegPath);
      await runFfmpeg([
        '-threads', '2', '-filter_threads', '1', '-i', temporary.previewSrc,
        '-frames:v', '1', '-threads', '1', scratchFrame,
      ], options.ffmpegPath);
      if (inputs.poster) {
        await writeWebp(sourcePath(publicDirectory, item.thumbnail), temporary.thumbnail, 384, 72);
      } else {
        await writeWebp(scratchFrame, temporary.thumbnail, 384, 72);
      }
    }
    const dimensions = await sharp(item.type === 'image' ? temporary.previewSrc : scratchFrame).metadata();
    // A watcher may see a file while it is still being copied. Never attach previews
    // generated from the previous bytes to its replacement; a later scan will retry.
    const latestInputs = await inputSignature(item, publicDirectory);
    if (JSON.stringify(inputs) !== JSON.stringify(latestInputs)) throw new Error('Source changed while preparing previews; retry after the copy finishes');
    for (const [key, file] of Object.entries(temporary)) {
      if ((await stat(file)).size === 0) throw new Error('Generated preview is empty');
      await renameCompleteFile(file, path.join(outputDirectory, outputs[key]));
    }
    return { aspect: dimensions.width / dimensions.height };
  } finally {
    await Promise.all([...Object.values(temporary), scratchFrame].map((file) => rm(file, { force: true })));
  }
}

async function optimize(root, manifest, options) {
  if (manifest.isDemo || !manifest.items.length) return manifest;
  const onWarning = options.onWarning ?? console.warn;
  const onProgress = options.onProgress ?? console.info;
  const publicDirectory = path.join(root, 'public');
  const outputDirectory = path.join(publicDirectory, 'media-previews');
  const cachePath = path.join(outputDirectory, '.cache.json');
  await mkdir(outputDirectory, { recursive: true });
  const previous = await readFile(cachePath, 'utf8').then((content) => JSON.parse(content)).catch(() => null);
  const cache = previous?.version === PREVIEW_VERSION && previous.entries && typeof previous.entries === 'object' ? previous.entries : {};
  const entries = {};
  const result = new Map();
  const summary = { created: 0, cached: 0, failed: 0 };

  async function processItem(item) {
    try {
      if (!/^memory-\d{3,6}$/.test(item.id)) throw new Error('Unexpected media ID');
      const inputs = await inputSignature(item, publicDirectory);
      const fingerprint = createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 20);
      const prefix = `${item.id}-${fingerprint}`;
      const source = sourcePath(publicDirectory, item.src);
      let animated = false;
      let sourceMetadata;
      if (item.type === 'image') {
        sourceMetadata = await sharp(source).metadata();
        animated = (sourceMetadata.pages ?? 1) > 1 || path.extname(item.src).toLowerCase() === '.gif';
      }
      const outputs = {
        thumbnail: `${prefix}-thumb.webp`,
        previewSrc: `${prefix}-preview.${item.type === 'video' ? 'mp4' : 'webp'}`,
        ...(item.type === 'image' && !animated ? { displaySrc: `${prefix}-display.webp` } : {}),
      };
      let aspect;
      let details;
      const cached = cache[item.id];
      if (await validCachedEntry(cached, { fingerprint, outputs }, outputDirectory)) {
        aspect = cached.aspect;
        if (cached.details?.version === METADATA_VERSION) details = cached.details;
        summary.cached++;
      } else {
        ({ aspect } = await createPreviews(item, inputs, outputs, publicDirectory, outputDirectory, options));
        summary.created++;
      }
      details ??= await describeMemory(item, source, path.join(outputDirectory, outputs.thumbnail), sourceMetadata, options);
      entries[item.id] = {
        fingerprint,
        aspect,
        details,
        files: await Promise.all(Object.values(outputs).map(async (name) => ({ name, size: (await stat(path.join(outputDirectory, name))).size }))),
      };
      result.set(item.id, {
        ...item,
        aspect,
        ...(details.takenAt ? { takenAt: details.takenAt } : {}),
        ...(details.color ? { color: details.color } : {}),
        ...Object.fromEntries(Object.entries(outputs).map(([key, name]) => [key, `media-previews/${name}`])),
        ...(animated ? { displaySrc: item.src } : {}),
      });
    } catch (error) {
      summary.failed++;
      onWarning(`[media] ${item.id}: previews unavailable; using original media. ${error.message}`);
      // Failed work is never cached, so the next start/scan can repair it.
      result.set(item.id, item);
    }
  }

  const images = manifest.items.filter((item) => item.type === 'image');
  // Keep peak decoded image memory bounded, and never compete with video encoders.
  for (let index = 0; index < images.length; index += 2) await Promise.all(images.slice(index, index + 2).map(processItem));
  for (const item of manifest.items.filter((item) => item.type === 'video')) await processItem(item);
  const orderedEntries = Object.fromEntries(manifest.items.flatMap((item) => entries[item.id] ? [[item.id, entries[item.id]]] : []));
  await atomicWriteIfChanged(cachePath, `${JSON.stringify({ version: PREVIEW_VERSION, entries: orderedEntries }, null, 2)}\n`);
  onProgress(`[media] Previews: ${summary.created} created, ${summary.cached} reused, ${summary.failed} original fallbacks.`);
  options.onSummary?.(summary);
  return { ...manifest, items: manifest.items.map((item) => result.get(item.id) ?? item) };
}

export function optimizeMediaManifest(root, manifest, options = {}) {
  const resolved = path.resolve(root);
  // Vite can fire many events for a single large file copy. Serialize all work for
  // the same root so heavy encoders and cache writes never race within the server.
  const previous = pendingOptimizations.get(resolved) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => optimize(resolved, manifest, options));
  pendingOptimizations.set(resolved, pending);
  void pending.finally(() => { if (pendingOptimizations.get(resolved) === pending) pendingOptimizations.delete(resolved); }).catch(() => {});
  return pending;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: projectRoot } } });
  // Do not top-level-await this import: the manifest module also imports our
  // exported optimizer, and awaiting its evaluation here would deadlock the CLI.
  void import('./media-manifest.mjs').then(async ({ generateMediaManifest }) => {
    const manifest = await generateMediaManifest(values.root);
    console.log(`[media] ${manifest.items.length} ${manifest.isDemo ? 'demo' : 'local'} memories ready.`);
  }).catch((error) => {
    console.error(`[media] Cannot prepare previews: ${error.message}`);
    process.exitCode = 1;
  });
}
