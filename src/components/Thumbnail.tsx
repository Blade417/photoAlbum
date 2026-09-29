import { useState } from 'react';
import { ImageOff, Play } from 'lucide-react';
import type { MediaItem } from '../lib/media';

export function Thumbnail({ item, eager = false }: { item: MediaItem; eager?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = item.thumbnail || (item.type === 'image' ? item.previewSrc || item.src : undefined);
  return <>
    {src && !failed ? <img src={src} alt={item.title} loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false} onError={() => setFailed(true)}/> : <span className="media-placeholder">{item.type === 'video' ? <Play size={26}/> : <ImageOff size={26}/>}</span>}
    {item.type === 'video' && <span className="video-indicator"><Play size={11} fill="currentColor"/></span>}
  </>;
}
