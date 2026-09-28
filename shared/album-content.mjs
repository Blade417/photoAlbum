export const SITE_LIMITS = Object.freeze({
  name: 12,
  englishName: 40,
  eyebrow: 60,
  titleLine1: 30,
  titleLine2: 30,
  description: 240,
  exploreLabel: 12,
  introNote: 60,
  collectionTitle: 20,
  footerNote: 80,
  galleryTitle: 60,
  galleryDescription: 160,
  demoGalleryDescription: 160,
});
export const MEMORY_TITLE_LIMIT = 80;
export const MEMORY_SUBTITLE_LIMIT = 240;

export const DEFAULT_CONTENT = Object.freeze({
  version: 1,
  site: Object.freeze({
    name: '星屿',
    englishName: 'STELLAR MEMORIES',
    eyebrow: 'A UNIVERSE OF MOMENTS',
    titleLine1: '让回忆，',
    titleLine2: '自成宇宙。',
    description: '那些微小而闪亮的瞬间，\n终将汇成，属于我们的星河。',
    exploreLabel: '开始漫游',
    introNote: '每一颗星，都是一个故事',
    collectionTitle: '拾光集',
    footerNote: 'SOME MOMENTS ARE FOREVER',
    galleryTitle: '所有珍贵，皆有迹可循。',
    galleryDescription: '收藏每一个值得被记住的瞬间',
    demoGalleryDescription: '一场关于山海与远方的演示旅程',
  }),
  memories: Object.freeze({ demo: Object.freeze({}), personal: Object.freeze({}) }),
});

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label}必须是普通对象。`);
  }
  if (Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) {
    throw new Error(`${label}包含不支持的字段。`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const result = record(value, label);
  const supplied = Object.keys(result);
  if (supplied.length !== keys.length || supplied.some((key) => !keys.includes(key))) {
    throw new Error(`${label}的字段不完整或包含不支持的字段。`);
  }
  return result;
}

function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label}必须是 ${limit} 字以内的文本，且不能包含控制字符。`);
  }
  return value;
}

/** Validate and copy JSON; never merge arbitrary imported keys into application objects. */
export function validateContent(value) {
  const root = exactKeys(value, ['version', 'site', 'memories'], '文案配置');
  if (root.version !== 1) throw new Error('不支持的文案配置版本，需要 version: 1。');
  const rawSite = exactKeys(root.site, Object.keys(SITE_LIMITS), '页面文案');
  const site = Object.fromEntries(Object.entries(SITE_LIMITS).map(([key, limit]) => [key, text(rawSite[key], limit, key)]));
  if (!site.name.trim()) throw new Error('相册名称不能为空。');
  const rawMemories = exactKeys(root.memories, ['demo', 'personal'], '回忆文案');
  const memories = { demo: {}, personal: {} };
  for (const scope of ['demo', 'personal']) {
    const entries = record(rawMemories[scope], `${scope} 回忆文案`);
    if (Object.keys(entries).length > 99) throw new Error('每组最多支持 99 个回忆。');
    for (const [id, rawEntry] of Object.entries(entries)) {
      if (!/^memory-0(?:0[1-9]|[1-9]\d)$/.test(id)) {
        throw new Error('回忆编号必须在 memory-001 至 memory-099 之间。');
      }
      const entry = exactKeys(rawEntry, ['title', 'subtitle'], `${id} 文案`);
      memories[scope][id] = {
        title: text(entry.title, MEMORY_TITLE_LIMIT, `${id} 标题`),
        subtitle: text(entry.subtitle, MEMORY_SUBTITLE_LIMIT, `${id} 说明`),
      };
    }
  }
  return { version: 1, site, memories };
}
