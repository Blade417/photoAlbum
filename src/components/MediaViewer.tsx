import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, ChevronLeft, ChevronRight, ImageOff, MoveUpRight } from 'lucide-react';
import type { MediaItem } from '../lib/media';
import { formatMemoryDate } from '../lib/timeline';
import { Dialog } from './Dialog';

export function MediaViewer({ item, position, total, onClose, onStep, onFocus }: { item: MediaItem; position: number; total: number; onClose: () => void; onStep: (direction: number) => void; onFocus?: () => void }) {
  const [failed, setFailed] = useState(false);
  const date = formatMemoryDate(item);
  useEffect(() => setFailed(false), [item.id]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLVideoElement) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); onStep(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); onStep(1); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onStep]);
  return <Dialog label={item.title} onClose={onClose} className="viewer-backdrop">
    <div className="viewer-top"><span className="eyebrow">MEMORY NO. {String(item.index).padStart(3, '0')}</span><span className="viewer-counter">{String(position + 1).padStart(2, '0')} <i>/ {String(total).padStart(2, '0')}</i></span></div>
    <div className="viewer-stage">
      <button className="icon-button viewer-prev" aria-label="上一张" onClick={() => onStep(-1)} disabled={total < 2}><ChevronLeft/></button>
      {failed ? <div className="viewer-error"><ImageOff size={38}/><h3>这个瞬间暂时无法打开</h3><p>请检查素材文件是否完整，以及浏览器是否支持此格式。</p><a href={item.src} target="_blank" rel="noreferrer">打开原文件 <ArrowUpRight size={14}/></a></div> : item.type === 'video' ? <video key={item.id} src={item.src} poster={item.thumbnail} controls autoPlay playsInline preload="metadata" onError={() => setFailed(true)}/> : <img key={item.id} src={item.displaySrc || item.src} alt={item.title} decoding="async" onError={() => setFailed(true)}/>}
      <button className="icon-button viewer-next" aria-label="下一张" onClick={() => onStep(1)} disabled={total < 2}><ChevronRight/></button>
    </div>
    <div className="viewer-bottom"><div><div className="small-label">{item.type === 'video' ? '动态记忆' : '静止的时光'}<span>·</span>{item.demo ? '演示收藏' : '我的收藏'}{date && <><span>·</span><time className="viewer-date">{date}</time></>}</div><h2>{item.title}</h2><p>{item.subtitle}</p></div><div className="viewer-actions">{onFocus && <button className="text-button" onClick={onFocus}>在星空中靠近 <MoveUpRight size={16}/></button>}<a className="icon-button" href={item.src} download aria-label="下载原文件" title="下载原文件"><ArrowDownToLine size={18}/></a></div></div>
  </Dialog>;
}
