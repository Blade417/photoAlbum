import { link, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, canonicalNumber } from './media-manifest.mjs';
import { readCaptureTime } from './media-optimize.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_NUMBER = 999999;
const NAMED = /^memory-(\d+)(?:\.poster)?\.[^.]+$/i;
const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini']);
// Common camera and phone formats the album cannot show yet, and what to convert them to.
const CONVERSIONS = new Map([
  ...['heic', 'heif', 'dng', 'nef', 'nrw', 'cr2', 'cr3', 'arw', 'raf', 'rw2', 'orf'].map((extension) => [extension, 'JPG']),
  ...['mov', 'm4v', 'avi', 'mkv', 'mts', '3gp'].map((extension) => [extension, 'MP4']),
]);
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function sortTime(takenAt) {
  if (!takenAt) return Infinity;
  // Zone-less wall-clock times are compared as recorded, as the album does.
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(takenAt) ? takenAt : `${takenAt}Z`);
}

/** Finds files dropped into the media folder under other names and the numbers they will receive. */
export async function planImport(mediaDirectory, options = {}) {
  await mkdir(mediaDirectory, { recursive: true });
  const entries = await readdir(mediaDirectory, { withFileTypes: true });
  let largest = 0;
  const incoming = [];
  const unsupported = [];
  const others = [];
  const folders = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.push(entry.name);
      continue;
    }
    if (!entry.isFile() || entry.name.startsWith('.') || SYSTEM_FILES.has(entry.name.toLowerCase())) continue;
    const named = NAMED.exec(entry.name);
    if (named) {
      largest = Math.max(largest, Number(named[1]));
      continue;
    }
    const extension = path.extname(entry.name).slice(1).toLowerCase();
    if (MEDIA_EXTENSIONS.includes(extension)) incoming.push({ file: entry.name, extension, type: VIDEO_EXTENSIONS.has(extension) ? 'video' : 'image' });
    else if (CONVERSIONS.has(extension)) unsupported.push({ file: entry.name, convertTo: CONVERSIONS.get(extension) });
    else others.push(entry.name);
  }
  if (largest + incoming.length > MAX_NUMBER) throw new Error(`编号将超过 ${MAX_NUMBER}，请先整理 public/media 中的编号。`);
  for (const item of incoming) {
    // Unreadable metadata only affects the order; the album lists such files as undated.
    item.takenAt = await readCaptureTime(path.join(mediaDirectory, item.file), item.type, options).catch(() => undefined);
  }
  incoming.sort((left, right) => sortTime(left.takenAt) - sortTime(right.takenAt) || names.compare(left.file, right.file));
  return {
    moves: incoming.map((item, offset) => ({ ...item, to: `memory-${canonicalNumber(largest + offset + 1)}.${item.extension}` })),
    unsupported: unsupported.sort((left, right) => names.compare(left.file, right.file)),
    others: others.sort(names.compare),
    folders: folders.sort(names.compare),
  };
}

/** Renames a file without ever replacing an existing one. */
export async function moveWithoutOverwrite(source, destination) {
  try {
    // A hard link fails with EEXIST instead of replacing an existing memory.
    await link(source, destination);
  } catch (error) {
    if (error.code === 'EEXIST') throw error;
    // Drives without hard links (FAT/exFAT) fall back to check-then-rename.
    if (await stat(destination).then(() => true, () => false)) {
      throw Object.assign(new Error(`${path.basename(destination)} 已存在`), { code: 'EEXIST' });
    }
    await rename(source, destination);
    return;
  }
  try {
    await unlink(source);
  } catch (error) {
    // Keep a single name, otherwise the next import would add the file twice.
    await unlink(destination).catch(() => {});
    throw error;
  }
}

export async function importMedia(mediaDirectory, { dryRun = false, ...options } = {}) {
  const plan = await planImport(mediaDirectory, options);
  const renamed = [];
  const failed = [];
  if (!dryRun) {
    for (const move of plan.moves) {
      try {
        await moveWithoutOverwrite(path.join(mediaDirectory, move.file), path.join(mediaDirectory, move.to));
        renamed.push(move);
      } catch (error) {
        failed.push({ ...move, reason: ['EBUSY', 'EPERM', 'EACCES'].includes(error.code) ? '文件正被占用，可能还在复制' : error.message });
      }
    }
  }
  return { ...plan, renamed, failed };
}

function describeTime(takenAt) {
  if (!takenAt) return '未记录拍摄时间';
  if (!takenAt.endsWith('Z')) return takenAt.slice(0, 16).replace('T', ' ');
  const local = new Date(takenAt);
  const pad = (value) => String(value).padStart(2, '0');
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

export function describeImport(result, dryRun = false) {
  const lines = [];
  if (!result.moves.length) lines.push('[import] 没有需要改名的新文件。把照片或视频直接放进 public/media/ 后再运行。');
  else {
    lines.push(dryRun ? '[import] 预览，未改动任何文件。将按拍摄时间编号：' : '[import] 按拍摄时间编号：');
    result.moves.forEach((move) => lines.push(`  ${move.file} → ${move.to}（${describeTime(move.takenAt)}）`));
  }
  if (result.failed.length) {
    lines.push('[import] 以下文件没有改名，稍后可再次运行：');
    result.failed.forEach((move) => lines.push(`  ${move.file}：${move.reason}`));
  }
  if (result.unsupported.length) lines.push(`[import] 暂不支持的格式，未改名：${result.unsupported.map(({ file, convertTo }) => `${file}（请转成 ${convertTo}）`).join('、')}`);
  if (result.others.length) lines.push(`[import] 不是照片或视频，未处理：${result.others.join('、')}`);
  if (result.unsupported.length || result.others.length) lines.push('[import] 这些文件不会出现在相册里，但构建时会被复制到 dist，建议移出 public/media/。');
  if (result.folders.length) lines.push(`[import] 子文件夹不会被导入：${result.folders.map((folder) => `${folder}/`).join('、')}，请把文件直接放在 public/media/ 下。`);
  if (dryRun && result.moves.length) lines.push('[import] 确认无误后运行 npm run media:import 正式改名。');
  else if (result.renamed.length) lines.push(`[import] 已改名 ${result.renamed.length} 个文件。开发服务运行中时会自动生成预览并刷新页面；否则下次运行 npm run dev 或 npm run build 时生成。`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string', default: projectRoot }, 'dry-run': { type: 'boolean', default: false } } });
  const dryRun = values['dry-run'];
  try {
    const result = await importMedia(path.join(path.resolve(values.root), 'public', 'media'), { dryRun });
    console.log(describeImport(result, dryRun));
    if (result.failed.length) process.exitCode = 1;
  } catch (error) {
    console.error(`[import] ${error.message}`);
    process.exitCode = 1;
  }
}
