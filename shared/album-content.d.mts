export interface MemoryText {
  title: string;
  subtitle: string;
  /** Overrides the recorded capture date, as YYYY-MM-DD. */
  date?: string;
}
export interface AlbumContent {
  version: 2;
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
    demo: Record<string, MemoryText>;
    personal: Record<string, MemoryText>;
  };
}
export const DEFAULT_CONTENT: AlbumContent;
export const SITE_LIMITS: Readonly<Record<keyof AlbumContent['site'], number>>;
export const MEMORY_TITLE_LIMIT: number;
export const MEMORY_SUBTITLE_LIMIT: number;
export const CONTENT_VERSION: 2;
export const MAX_MEMORY_ENTRIES: number;
export function validateContent(value: unknown): AlbumContent;
