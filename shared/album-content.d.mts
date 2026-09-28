export interface AlbumContent {
  version: 1;
  site: {
    name: string;
    englishName: string;
    eyebrow: string;
    titleLine1: string;
    titleLine2: string;
    description: string;
    exploreLabel: string;
    introNote: string;
    collectionTitle: string;
    footerNote: string;
    galleryTitle: string;
    galleryDescription: string;
    demoGalleryDescription: string;
  };
  memories: {
    demo: Record<string, { title: string; subtitle: string }>;
    personal: Record<string, { title: string; subtitle: string }>;
  };
}
export const DEFAULT_CONTENT: AlbumContent;
export const SITE_LIMITS: Readonly<Record<keyof AlbumContent['site'], number>>;
export const MEMORY_TITLE_LIMIT: number;
export const MEMORY_SUBTITLE_LIMIT: number;
export function validateContent(value: unknown): AlbumContent;
