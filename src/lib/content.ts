import { DEFAULT_CONTENT, validateContent, type AlbumContent } from '../../shared/album-content.mjs';

export { DEFAULT_CONTENT, validateContent, SITE_LIMITS, MEMORY_TITLE_LIMIT, MEMORY_SUBTITLE_LIMIT } from '../../shared/album-content.mjs';
export type { AlbumContent } from '../../shared/album-content.mjs';

type StorageMode = 'project' | 'browser';
let storageMode: StorageMode | null = null;

function contentUrl(file: string): string {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${file}`;
}

function draftKey(): string {
  const base = new URL(import.meta.env.BASE_URL, window.location.href);
  return `stellar-album:content:v1:${base.origin}${base.pathname}`;
}

async function fetchJson(file: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(contentUrl(file), { cache: 'no-store', signal: AbortSignal.timeout(5000), ...init });
  if (!response.ok) {
    const reason = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof reason?.error === 'string' ? reason.error : `请求失败（HTTP ${response.status}）。`);
  }
  return response.json();
}

export async function loadContent(): Promise<{ content: AlbumContent; storage: StorageMode; hasLocalDraft: boolean; warning?: string }> {
  const warnings: string[] = [];
  if (import.meta.env.DEV) {
    try {
      const result = await fetchJson('__album/content') as { content?: unknown; writable?: unknown; warning?: unknown };
      if (result.writable !== true) throw new Error('该服务不支持写入工程。');
      const content = validateContent(result.content);
      storageMode = 'project';
      // A project's source file is authoritative; never silently apply a browser-only draft here.
      return { content, storage: 'project', hasLocalDraft: false, ...(typeof result.warning === 'string' ? { warning: result.warning } : {}) };
    } catch {
      warnings.push('当前连接无法直接保存到工程文件；修改可保存到本机或导出。请使用 localhost 或 127.0.0.1 访问开发服务以写入工程。');
    }
  }

  let content = validateContent(DEFAULT_CONTENT);
  try { content = validateContent(await fetchJson('album-content.json')); }
  catch { warnings.push('album-content.json 无法读取或格式错误，已使用默认文案，可在文案编辑器中修复。'); }
  storageMode = 'browser';
  let hasLocalDraft = false;
  try {
    const draft = window.localStorage.getItem(draftKey());
    if (draft !== null) {
      try { content = validateContent(JSON.parse(draft)); hasLocalDraft = true; }
      catch { warnings.push('本机保存的文案格式错误，已忽略该草稿；重新保存即可替换。'); }
    }
  } catch { warnings.push('浏览器未允许读取本机草稿；仍可编辑并导出文案。'); }
  return { content, storage: 'browser', hasLocalDraft, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
}

export async function saveContent(value: AlbumContent): Promise<{ storage: StorageMode }> {
  const content = validateContent(value);
  if (storageMode === null) await loadContent();
  if (storageMode === 'project') {
    try {
      const result = await fetchJson('__album/content', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(content),
      }) as { ok?: unknown };
      if (result.ok !== true) throw new Error('服务没有确认保存结果。');
    } catch (error) {
      throw new Error(`工程文件未保存。${error instanceof Error ? error.message : '请检查开发服务是否仍在运行。'} 你的编辑仍保留在当前页面，可导出备份。`);
    }
    return { storage: 'project' };
  }
  try { window.localStorage.setItem(draftKey(), JSON.stringify(content)); }
  catch { throw new Error('无法保存到本机：浏览器存储不可用或空间不足。你的编辑仍保留在当前页面，请导出 JSON 备份。'); }
  return { storage: 'browser' };
}

export function clearLocalDraft(): void {
  try { window.localStorage.removeItem(draftKey()); }
  catch { throw new Error('浏览器未允许清除本机草稿，请在浏览器设置中清除此站点的数据。'); }
}
