export interface MediaItem {
  id: string;
  index: number;
  type: 'image' | 'video';
  src: string;
  thumbnail?: string;
  previewSrc?: string;
  displaySrc?: string;
  aspect?: number;
  /** Recorded capture time: local wall clock, optionally with a zone. */
  takenAt?: string;
  /** Representative #rrggbb colour of the preview. */
  color?: string;
  /** Owner-provided YYYY-MM-DD date that replaces takenAt. */
  date?: string;
  title: string;
  subtitle: string;
  demo?: boolean;
}

export interface MediaManifest {
  items: MediaItem[];
  isDemo: boolean;
  /** A recoverable load error, if the bundled demonstration is being used. */
  warning?: string;
}

const demoCount = 99;
const demoScenes = [
  ['alpine.jpg', '山的另一边', '山野 · 远行的记忆'],
  ['stillwater.jpg', '湖泊的来信', '湖畔 · 时间静止的一刻'],
  ['forest.jpg', '走进绿意', '森林 · 一场安静的漫游'],
  ['horizon.jpg', '远方有光', '旷野 · 把自由交给风'],
  ['starlight.jpg', '与星空相遇', '深夜 · 许一个小小的愿望'],
  ['wander.jpg', '没有目的地', '旅途 · 记住路上的风景'],
  ['waterfall.jpg', '听见山涧', '山谷 · 水流经过的夏天'],
  ['wildlife.jpg', '森林里的朋友', '自然 · 温柔的偶遇'],
  ['lakeside.jpg', '蓝色的午后', '湖岸 · 每一次呼吸都自由'],
  ['ocean.jpg', '海的形状', '海边 · 风里有盐的味道'],
  ['meadow.jpg', '一整个春天', '花野 · 盛开在记忆里'],
  ['blossom.jpg', '花开的声音', '春日 · 收藏一瞬的温柔'],
];

function assetUrl(source: string): string {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${source.replace(/^\/+/, '')}`;
}

function withAssetUrls(item: MediaItem): MediaItem {
  return {
    ...item,
    src: assetUrl(item.src),
    ...(item.thumbnail ? { thumbnail: assetUrl(item.thumbnail) } : {}),
    ...(item.previewSrc ? { previewSrc: assetUrl(item.previewSrc) } : {}),
    ...(item.displaySrc ? { displaySrc: assetUrl(item.displaySrc) } : {}),
  };
}

function fallbackManifest(): MediaManifest {
  return {
    isDemo: true,
    warning: '素材清单暂时无法读取，已展示内置演示。请检查部署时是否包含 media-manifest.json。',
    items: Array.from({ length: demoCount }, (_, offset): MediaItem => {
      const index = offset + 1;
      const [file, title, subtitle] = demoScenes[offset % demoScenes.length];
      const video = index % 9 === 0;
      return withAssetUrls({
        id: `memory-${String(index).padStart(3, '0')}`,
        index,
        type: video ? 'video' : 'image',
        src: `demo/${video ? 'flower.mp4' : file}`,
        thumbnail: `demo/${video ? 'blossom.jpg' : file}`,
        title: video ? '风经过花园' : title,
        subtitle: video ? '动态回忆 · 每一秒都值得收藏' : subtitle,
        demo: true,
      });
    }),
  };
}

function isMediaItem(value: unknown): value is MediaItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MediaItem>;
  return typeof item.id === 'string'
    && Number.isInteger(item.index) && Number(item.index) >= 1
    && (item.type === 'image' || item.type === 'video')
    && typeof item.src === 'string' && item.src.length > 0
    && typeof item.title === 'string' && typeof item.subtitle === 'string'
    && (item.thumbnail === undefined || typeof item.thumbnail === 'string')
    && (item.previewSrc === undefined || typeof item.previewSrc === 'string')
    && (item.displaySrc === undefined || typeof item.displaySrc === 'string')
    && (item.aspect === undefined || (Number.isFinite(item.aspect) && item.aspect > 0))
    && (item.takenAt === undefined || (typeof item.takenAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(item.takenAt)))
    && (item.color === undefined || (typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color)));
}

export async function loadMedia(): Promise<MediaManifest> {
  try {
    const response = await fetch(assetUrl('media-manifest.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Media manifest returned HTTP ${response.status}`);
    const manifest: unknown = await response.json();
    if (!manifest || typeof manifest !== 'object' || !('items' in manifest) || !Array.isArray(manifest.items)) {
      throw new Error('Invalid media manifest');
    }
    const seen = new Set<number>();
    const items = manifest.items.filter(isMediaItem).filter((item) => {
      if (seen.has(item.index)) return false;
      seen.add(item.index);
      return true;
    }).sort((left, right) => left.index - right.index).map(withAssetUrls);
    if (!items.length) throw new Error('The media manifest contains no usable items');
    return {
      items,
      isDemo: 'isDemo' in manifest && manifest.isDemo === true,
    };
  } catch (error) {
    console.warn('[media] Falling back to bundled demo:', error);
    return fallbackManifest();
  }
}
