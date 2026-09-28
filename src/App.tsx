import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, CircleHelp, Expand, Film, Grid2X2, Image as ImageIcon, Maximize, Minimize, Minus, MousePointer2, Move, Orbit, Pause, Play, Plus, RotateCcw, Settings2, Sparkles, X } from 'lucide-react';
import { GalaxyScene, type GalaxyHandle } from './components/GalaxyScene';
import { Dialog } from './components/Dialog';
import { MediaViewer } from './components/MediaViewer';
import { Thumbnail } from './components/Thumbnail';
import { loadMedia, type MediaManifest, type MediaItem } from './lib/media';
import { ContentEditor } from './components/ContentEditor';
import { DEFAULT_CONTENT, loadContent, saveContent, type AlbumContent } from './lib/content';

type Filter = 'all' | 'image' | 'video';
export default function App() {
  const [manifest, setManifest] = useState<MediaManifest | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sceneError, setSceneError] = useState('');
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<'galaxy' | 'grid'>('galaxy');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [editor, setEditor] = useState(false);
  const [content, setContent] = useState<AlbumContent>(DEFAULT_CONTENT);
  const [contentReady, setContentReady] = useState(false);
  const [contentStorage, setContentStorage] = useState<'project' | 'browser'>('browser');
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const [contentWarning, setContentWarning] = useState('');
  const [autoRotate, setAutoRotate] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [immersive, setImmersive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [journey, setJourney] = useState<'idle' | 'flying' | 'arrived' | 'cancelled'>('idle');
  const [showArrival, setShowArrival] = useState(false);
  const [journeyTargetId, setJourneyTargetId] = useState<string | null>(null);
  const [stripPage, setStripPage] = useState(0);
  const [toast, setToast] = useState('');
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const galaxy = useRef<GalaxyHandle>(null);

  useEffect(() => {
    let cancelled = false;
    loadMedia().then(value => { if (!cancelled) setManifest(value); }).catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : '无法读取相册'); });
    loadContent().then(value => {
      if (cancelled) return;
      setContent(value.content); setContentStorage(value.storage); setHasLocalDraft(value.hasLocalDraft); setContentWarning(value.warning ?? ''); setContentReady(true);
    }).catch(() => { if (!cancelled) { setContentReady(true); setContentWarning('文字配置暂时无法读取，正在显示默认文字。'); } });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { document.title = `${content.site.name} · ${content.site.titleLine1}${content.site.titleLine2}`; }, [content]);
  useEffect(() => {
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (view !== 'galaxy' || selectedId || help || editor) setShowArrival(false);
  }, [view, selectedId, help, editor]);
  useEffect(() => {
    if (!focusTarget || view !== 'galaxy' || selectedId) return;
    const timer = setTimeout(() => { galaxy.current?.focus(focusTarget); setFocusTarget(null); }, 120);
    return () => clearTimeout(timer);
  }, [focusTarget, view, selectedId]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (selectedId || help || editor) return;
      if (event.key === 'Escape') { galaxy.current?.cancelJourney(); setShowArrival(false); setImmersive(false); return; }
      if (event.target instanceof HTMLElement && (event.target.isContentEditable || /INPUT|TEXTAREA|SELECT|BUTTON|VIDEO|A/.test(event.target.tagName))) return;
      if (event.code === 'Space' && view === 'galaxy') { event.preventDefault(); setAutoRotate(value => !value); }
      if (/^[wasdqe]$/i.test(event.key) || event.key.startsWith('Arrow')) setShowArrival(false);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [selectedId, help, editor, view]);

  const items = useMemo(() => manifest?.items.map(item => ({ ...item, ...content.memories[manifest.isDemo ? 'demo' : 'personal'][item.id] })) ?? [], [manifest, content]);
  const filtered = useMemo(() => items.filter(item => filter === 'all' || item.type === filter), [items, filter]);
  const selected = filtered.find(item => item.id === selectedId);
  const arrivalItem = filtered.find(item => item.id === journeyTargetId);
  const selectedIndex = filtered.findIndex(item => item.id === selectedId);
  const photos = items.filter(item => item.type === 'image').length;
  const videos = items.length - photos;
  const pageCount = Math.max(1, Math.ceil(filtered.length / 8));
  const stripItems = filtered.slice(stripPage * 8, stripPage * 8 + 8);
  const onReady = useCallback(() => setReady(true), []);
  const onSceneError = useCallback((message: string) => { setSceneError(message); setReady(true); setView('grid'); setJourney('cancelled'); setShowArrival(false); }, []);
  const onSelect = useCallback((item: MediaItem) => setSelectedId(item.id), []);
  const onJourneyChange = useCallback((state: 'flying' | 'arrived' | 'cancelled', targetId: string | null) => {
    setJourney(state); setJourneyTargetId(targetId); setShowArrival(state === 'arrived');
  }, []);
  const step = useCallback((direction: number) => {
    setSelectedId(previous => { const current = filtered.findIndex(item => item.id === previous); return filtered[(current + direction + filtered.length) % filtered.length]?.id ?? null; });
  }, [filtered]);
  const changeFilter = (next: Filter) => { galaxy.current?.cancelJourney(); setShowArrival(false); setFilter(next); setStripPage(0); setSelectedId(null); };
  const reset = () => { galaxy.current?.reset(); setEntered(false); setShowArrival(false); setJourney('idle'); setAutoRotate(!window.matchMedia('(prefers-reduced-motion: reduce)').matches); };
  const focusCanvas = () => document.querySelector<HTMLCanvasElement>('.galaxy-scene canvas')?.focus({ preventScroll: true });
  const beginJourney = () => {
    if (!ready || sceneError || !filtered.length || journey === 'flying') return;
    setEntered(true); setShowArrival(false); setAutoRotate(false);
    galaxy.current?.beginJourney(); focusCanvas();
  };
  const takeOverJourney = () => { galaxy.current?.cancelJourney(); setShowArrival(false); focusCanvas(); };
  const saveWords = async (next: AlbumContent) => {
    const result = await saveContent(next);
    setContent(next); setContentStorage(result.storage); setHasLocalDraft(result.storage === 'browser'); setContentWarning('');
    return result.storage;
  };
  const toggleFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else setToast('当前浏览器暂不支持全屏，可使用沉浸模式。'); }
    catch { setToast('全屏未能开启，可使用沉浸模式继续浏览。'); }
  };

  const filters = <div className="filter-tabs" role="group" aria-label="素材类型">{([{ key: 'all', label: '全部', count: items.length }, { key: 'image', label: '照片', count: photos }, { key: 'video', label: '视频', count: videos }] as const).map(tab => <button key={tab.key} className={filter === tab.key ? 'active' : ''} onClick={() => changeFilter(tab.key)} aria-pressed={filter === tab.key}>{tab.label}<span>{String(tab.count).padStart(2, '0')}</span></button>)}</div>;

  return <main className={`app ${immersive ? 'is-immersive' : ''} ${view === 'grid' ? 'is-grid' : ''} ${journey === 'flying' ? 'is-journey' : ''}`} onPointerDownCapture={event => { if (event.target instanceof HTMLCanvasElement) setShowArrival(false); }} onWheelCapture={event => { if (event.target instanceof HTMLCanvasElement) setShowArrival(false); }}>
    <div className="space-background" aria-hidden="true"/><div className="grain" aria-hidden="true"/>
    {manifest && !sceneError && <GalaxyScene ref={galaxy} items={filtered} autoRotate={autoRotate} active={view === 'galaxy' && !selected && !help && !editor} onSelect={onSelect} onReady={onReady} onError={onSceneError} onJourneyChange={onJourneyChange}/>}
    <header className="header ui-layer">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView(sceneError ? 'grid' : 'galaxy'); setFilter('all'); setStripPage(0); reset(); }} aria-label={`${content.site.name}首页`}><span className="brand-symbol"><Sparkles size={26} strokeWidth={1.2}/></span><span><strong>{content.site.name}<span className="brand-dot">.</span></strong><small>{content.site.englishName}</small></span></a>
      <nav className="main-nav" aria-label="相册视图"><button onClick={() => setView('galaxy')} className={view === 'galaxy' ? 'active' : ''} disabled={Boolean(sceneError)}><Orbit size={16}/>星空漫游</button><button onClick={() => setView('grid')} className={view === 'grid' ? 'active' : ''}><Grid2X2 size={15}/>相册总览</button></nav>
      <div className="header-actions"><span className="collection-status"><span className="status-dot"/>{manifest?.isDemo ? '灵感宇宙' : '我的宇宙'}</span><button className="text-button edit-content-button" aria-label="编辑文字" title="编辑文字" disabled={!contentReady || !manifest} onClick={() => setEditor(true)}><Settings2 size={16}/><span>编辑文字</span></button><button className="icon-button help-button" aria-label="操作指南" onClick={() => setHelp(true)}><CircleHelp size={18}/></button>{view === 'galaxy' && <><span className="header-divider"/><button className="text-button immersive-button" onClick={() => { setImmersive(true); focusCanvas(); }}><Expand size={15}/><span>沉浸模式</span></button></>}</div>
    </header>

    {view === 'galaxy' && <>
      <section className={`intro ui-layer ${entered ? 'intro-hidden' : ''}`}>
        <div className="eyebrow"><span className="tiny-line"/>{content.site.eyebrow}</div>
        <h1>{content.site.titleLine1}<br/><span>{content.site.titleLine2}</span></h1>
        <p>{content.site.description}</p>
        <button className="explore-button journey-start" disabled={!ready || !filtered.length || journey === 'flying'} onClick={beginJourney}><span>{content.site.exploreLabel}</span><span className="journey-start-icon"><ArrowUpRight size={17}/></span></button>
        <div className="intro-caption"><span>∞</span>{content.site.introNote}</div>
      </section>
      <div className="coordinate ui-layer"><span className="coordinate-star">✧</span><div>自由视角<small>FREE EXPLORATION</small></div><span className="coordinate-value">360°</span></div>
      <div className="scene-caption ui-layer"><span className="status-dot"/><span>{manifest?.isDemo ? '演示星空' : '回忆星空'}</span><span className="caption-divider"/> {String(filtered.length).padStart(2, '0')} 个瞬间，正在闪耀</div>
      {journey === 'flying' && <div className="journey-indicator ui-layer"><div className="journey-orbit" aria-hidden="true"><span/><Sparkles size={15}/></div><div className="journey-indicator-copy" role="status"><span className="eyebrow">INTO YOUR UNIVERSE</span><strong>正在穿过星河</strong><small>拖动或滚动，即可自由接管</small></div><button className="text-button" onClick={takeOverJourney} aria-label="跳过入场">跳过 <ArrowRight size={13}/></button><span className="journey-progress" aria-hidden="true"/></div>}
      {showArrival && arrivalItem && <section className="arrival-card ui-layer" aria-label="已抵达一段回忆"><button className="icon-button arrival-dismiss" aria-label="关闭抵达提示" onClick={takeOverJourney}><X size={15}/></button><div className="eyebrow"><span className="four-star">✦</span> CHANCE ENCOUNTER · {String(arrivalItem.index).padStart(3, '0')}</div><p className="arrival-kicker" role="status">偶然遇见，一段美好。</p><h2>{arrivalItem.title || '一段值得收藏的回忆'}</h2><p className="arrival-description">{arrivalItem.subtitle}</p><button className="text-button arrival-open" onClick={() => setSelectedId(arrivalItem.id)}>打开这段回忆 <ArrowUpRight size={15}/></button><button className="text-button arrival-free" onClick={takeOverJourney}>继续自由探索 <ArrowRight size={13}/></button></section>}
      <aside className="view-controls ui-layer" aria-label="视角控制"><button className="icon-button" aria-label="拉近" title="拉近" onClick={() => galaxy.current?.zoom(1)}><Plus size={19}/></button><span/><button className="icon-button" aria-label="拉远" title="拉远" onClick={() => galaxy.current?.zoom(-1)}><Minus size={19}/></button><div className="control-separator"/><button className="icon-button" aria-label="重置视角" title="重置视角 · R" onClick={reset}><RotateCcw size={17}/></button><button className="icon-button" aria-label={fullscreen ? '退出全屏' : '全屏浏览'} title="全屏浏览" onClick={toggleFullscreen}>{fullscreen ? <Minimize size={17}/> : <Maximize size={17}/>}</button></aside>
      <section className="memory-dock ui-layer" aria-label="回忆导航">
        <div className="dock-heading"><div className="dock-title"><span className="four-star">✦</span><span>{content.site.collectionTitle}</span><small>THE COLLECTION</small>{manifest?.isDemo && <span className="demo-badge">演示</span>}</div><button className="text-button" onClick={() => setView('grid')}>查看全部 <ArrowRight size={14}/></button></div>
        <div className="dock-body"><div className="dock-summary"><strong>{String(items.length).padStart(2, '0')}<span> / {manifest?.capacity ?? 99}</span></strong><div><ImageIcon size={11}/>{photos}<span/><Film size={11}/>{videos}</div></div><button className="strip-arrow icon-button" aria-label="上一组回忆" onClick={() => setStripPage(value => (value - 1 + pageCount) % pageCount)} disabled={pageCount < 2}><ChevronLeft size={17}/></button><div className="thumbnail-strip">{stripItems.map(item => <button key={item.id} className="strip-thumbnail" onClick={() => setSelectedId(item.id)} aria-label={`查看${item.type === 'video' ? '视频' : '照片'}：${item.title}`}><Thumbnail item={item} eager/><span className="thumbnail-index">{String(item.index).padStart(2, '0')}</span></button>)}{!stripItems.length && <p className="strip-empty">这里还没有{filter === 'video' ? '视频' : '照片'}</p>}</div><button className="strip-arrow icon-button" aria-label="下一组回忆" onClick={() => setStripPage(value => (value + 1) % pageCount)} disabled={pageCount < 2}><ChevronRight size={17}/></button><div className="dock-auto"><button className={autoRotate ? 'auto-button active' : 'auto-button'} onClick={() => setAutoRotate(value => !value)} aria-label={autoRotate ? '暂停自动漫游' : '开启自动漫游'} aria-pressed={autoRotate}>{autoRotate ? <Pause size={15}/> : <Play size={15}/>}</button><span>自动漫游</span></div></div>
      </section>
      <footer className="footer ui-layer"><div className="gesture-hints"><span><MousePointer2 size={13}/>拖动旋转</span><i/><span><Move size={13}/>滚轮缩放</span><i/><span>点击，走近一段回忆</span></div><span className="footer-note">{content.site.footerNote} <span>✦</span></span></footer>
      {filter !== 'all' && <button className="floating-filter ui-layer" onClick={() => changeFilter('all')}>仅看{filter === 'video' ? '视频' : '照片'} <X size={12}/></button>}
      {manifest && !filtered.length && <div className="empty-scene"><Sparkles size={30}/><h2>这一片星空，静待点亮</h2><p>换一个分类，继续发现美好。</p><button className="primary-button" onClick={() => changeFilter('all')}>查看全部回忆</button></div>}
    </>}

    {view === 'grid' && <section className="gallery ui-layer"><div className="gallery-heading"><div><span className="eyebrow">THE MEMORY ARCHIVE</span><h1>{content.site.galleryTitle}</h1><p>{manifest?.isDemo ? content.site.demoGalleryDescription : content.site.galleryDescription}<span>·</span>共 {items.length} 个瞬间</p></div>{filters}</div>{sceneError && <p className="notice">{sceneError} 你仍可以在这里浏览所有照片和视频。</p>}<div className="gallery-grid">{filtered.map(item => <button className="gallery-card" key={item.id} onClick={() => setSelectedId(item.id)}><div className="gallery-image"><Thumbnail item={item}/><span className="card-open"><ArrowUpRight size={19}/></span><span className="card-type">{item.type === 'video' ? 'VIDEO' : 'PHOTO'}</span></div><div className="card-caption"><div><h3>{item.title}</h3><p>{item.subtitle}</p></div><span>{String(item.index).padStart(3, '0')}</span></div></button>)}</div>{!filtered.length && <div className="gallery-empty"><Film size={32}/><h2>还没有这一类回忆</h2><button className="text-button" onClick={() => changeFilter('all')}>返回全部 <ArrowRight size={15}/></button></div>}<p className="gallery-end">{filtered.length > 0 ? '你已抵达这片星河的尽头' : '每个瞬间，都值得被收藏'}<span>✦</span></p></section>}

    {(!manifest || (!ready && view === 'galaxy')) && !loadError && <div className="loading-indicator" role="status"><span className="loading-orbit"/>正在点亮星空…</div>}
    {loadError && <div className="load-error"><Sparkles size={32}/><h2>星空暂时未能开启</h2><p>{loadError}</p><button className="primary-button" onClick={() => window.location.reload()}>重新加载</button></div>}
    {immersive && <button className="exit-immersive icon-button" aria-label="退出沉浸模式" onClick={() => setImmersive(false)}><Minimize size={19}/><span>退出沉浸</span></button>}
    {selected && <MediaViewer item={selected} position={selectedIndex} total={filtered.length} onClose={() => setSelectedId(null)} onStep={step} onFocus={sceneError ? undefined : () => { setFocusTarget(selected.id); setSelectedId(null); setView('galaxy'); setEntered(true); setAutoRotate(false); }}/>}
    {(manifest?.warning || contentWarning) && <div className="manifest-warning" role="status">{manifest?.warning || contentWarning}</div>}
    {editor && manifest && <ContentEditor content={content} items={manifest.items} isDemo={manifest.isDemo} storage={contentStorage} hasLocalDraft={hasLocalDraft} onSave={saveWords} onClose={() => setEditor(false)}/>}
    {help && <Dialog label="星空漫游指南" onClose={() => setHelp(false)} className="help-dialog"><span className="eyebrow">A LITTLE GUIDE</span><h2>自在漫游，随心靠近。</h2><p className="help-intro">不必着急抵达，回忆都在这里。</p><div className="help-controls"><div><MousePointer2/><span><strong>旋转星空</strong><small>按住鼠标左键拖动 / 单指拖动</small></span></div><div><Plus/><span><strong>靠近与远离</strong><small>滚动鼠标滚轮 / 双指捏合</small></span></div><div><Move/><span><strong>自由移动</strong><small>鼠标右键拖动 / 双指拖动 / WASD、Q、E</small></span></div><div><ImageIcon/><span><strong>打开回忆</strong><small>点击星空中的照片或视频，方向键切换</small></span></div></div><div className="shortcut-row"><span><kbd>R</kbd>重置视角</span><span><kbd>Space</kbd>自动漫游</span><span><kbd>Esc</kbd>关闭浮层</span></div><button className="primary-button" onClick={() => { setHelp(false); setView(sceneError ? 'grid' : 'galaxy'); }}>去星空里看看 <ArrowRight size={16}/></button></Dialog>}
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
  </main>;
}
