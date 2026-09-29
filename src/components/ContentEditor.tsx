import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Check, FileText, Image as ImageIcon, Save, Search, Upload } from 'lucide-react';
import { Dialog } from './Dialog';
import { Thumbnail } from './Thumbnail';
import { MEMORY_SUBTITLE_LIMIT, MEMORY_TITLE_LIMIT, SITE_LIMITS, validateContent, type AlbumContent } from '../lib/content';
import type { MediaItem } from '../lib/media';
import { formatMemoryDate } from '../lib/timeline';

type StorageMode = 'project' | 'browser';
type SiteField = keyof AlbumContent['site'];
const fields: Array<{ key: SiteField; label: string; multiline?: boolean; wide?: boolean }> = [
  { key: 'name', label: '相册名称' }, { key: 'englishName', label: '英文名称' },
  { key: 'eyebrow', label: '首页小标题', wide: true },
  { key: 'titleLine1', label: '首页标题 · 第一行' }, { key: 'titleLine2', label: '首页标题 · 第二行' },
  { key: 'description', label: '首页介绍', multiline: true, wide: true },
  { key: 'exploreLabel', label: '漫游按钮文字' }, { key: 'introNote', label: '首页寄语' },
  { key: 'collectionTitle', label: '底部收藏集名称' }, { key: 'footerNote', label: '页脚寄语' },
  { key: 'galleryTitle', label: '相册总览标题', wide: true },
  { key: 'galleryDescription', label: '个人相册介绍', multiline: true },
  { key: 'demoGalleryDescription', label: '演示相册介绍', multiline: true },
];

export function ContentEditor({ content, items, isDemo, storage, hasLocalDraft, onSave, onClose }: {
  content: AlbumContent; items: MediaItem[]; isDemo: boolean; storage: StorageMode; hasLocalDraft: boolean;
  onSave: (content: AlbumContent) => Promise<StorageMode>; onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(content));
  const [tab, setTab] = useState<'site' | 'memories'>('site');
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const scope = isDemo ? 'demo' : 'personal';
  const dirty = JSON.stringify(draft) !== JSON.stringify(content);
  const selected = items.find(item => item.id === selectedId);
  const selectedText = selected ? draft.memories[scope][selected.id] ?? { title: selected.title, subtitle: selected.subtitle } : null;
  const visibleItems = items.filter(item => {
    const text = draft.memories[scope][item.id] ?? item;
    return `${item.id} ${text.title} ${text.subtitle}`.toLowerCase().includes(query.toLowerCase());
  });
  const updateSite = (field: SiteField, value: string) => {
    setDraft(previous => ({ ...previous, site: { ...previous.site, [field]: value } }));
    setMessage(''); setError('');
  };
  const updateMemory = (field: 'title' | 'subtitle', value: string) => {
    if (!selected || !selectedText) return;
    setDraft(previous => ({ ...previous, memories: { ...previous.memories, [scope]: { ...previous.memories[scope], [selected.id]: { ...selectedText, [field]: value } } } }));
    setMessage(''); setError('');
  };
  const updateDate = (value: string) => {
    if (!selected || !selectedText) return;
    const { date: _replaced, ...text } = selectedText;
    setDraft(previous => ({ ...previous, memories: { ...previous.memories, [scope]: { ...previous.memories[scope], [selected.id]: value ? { ...text, date: value } : text } } }));
    setMessage(''); setError('');
  };
  const recordedDate = selected?.takenAt ? formatMemoryDate({ takenAt: selected.takenAt }) : '';
  const draftDates = new Map(visibleItems.map(item => [item.id, formatMemoryDate({ ...item, ...draft.memories[scope][item.id] })]));
  const requestClose = () => { if (busy) return; if (dirty) setConfirmClose(true); else onClose(); };
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(''); setMessage(''); setConfirmClose(false);
    try {
      const mode = await onSave(validateContent(draft));
      setMessage(mode === 'project' ? '已保存到项目，刷新页面也会保留。' : '已保存到本机浏览器。要同步给其他人，请导出配置并更新网站。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const importFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setError(''); setMessage('');
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('配置文件太大，请选择小于 8 MB 的 JSON 文件。');
      const imported = validateContent(JSON.parse(await file.text()));
      setDraft(imported);
      setMessage('配置已载入编辑区。检查后点击保存，即可应用到相册。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法读取配置文件。'); }
    if (upload.current) upload.current.value = '';
  };
  const exportFile = () => {
    try {
      const validated = validateContent(draft);
      const blob = new Blob([`${JSON.stringify(validated, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'album-content.json'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(''); setMessage('已导出当前文字配置。将它放入项目 public 目录，再构建发布即可同步给所有访客。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '导出失败。'); }
  };

  return <Dialog label="编辑相册文字" onClose={requestClose} className="editor-backdrop">
    <div className="editor-heading"><span className="eyebrow">WORDS FOR YOUR UNIVERSE</span><h2>给回忆，添上一句心里话。</h2><p>首页文案、照片标题、视频说明，都在这里维护。</p></div>
    <div className={`editor-storage ${storage === 'project' ? 'project' : ''}`}><span className="status-dot"/><strong>{storage === 'project' ? '保存到项目文件' : '保存到本机浏览器'}</strong><span>{storage === 'project' ? '修改会写入 album-content.json，发布前重新构建即可。' : '只有当前浏览器可见；导出配置并更新网站后，其他人才能看到。'}</span>{storage === 'browser' && hasLocalDraft && <small>已有本机修改</small>}</div>
    <div className="editor-toolbar"><div className="editor-tabs" role="tablist" aria-label="文字分类"><button role="tab" aria-selected={tab === 'site'} onClick={() => setTab('site')}><FileText size={15}/>页面文字</button><button role="tab" aria-selected={tab === 'memories'} onClick={() => setTab('memories')}><ImageIcon size={15}/>照片与视频<span>{items.length}</span></button></div><div className="editor-file-actions"><input ref={upload} type="file" accept=".json,application/json" aria-label="导入文字配置" hidden onChange={event => void importFile(event.target.files?.[0])}/><button className="text-button" disabled={busy} onClick={() => upload.current?.click()}><Upload size={13}/><span>导入</span></button><button className="text-button" disabled={busy} onClick={exportFile}><ArrowDownToLine size={13}/><span>导出</span></button></div></div>
    <fieldset className="editor-body" disabled={busy}>
      {tab === 'site' ? <div className="site-fields" role="tabpanel" aria-label="页面文字">{fields.map(field => <label key={field.key} className={`editor-field ${field.wide ? 'wide' : ''}`}><span>{field.label}<small>{draft.site[field.key].length} / {SITE_LIMITS[field.key]}</small></span>{field.multiline ? <textarea rows={3} value={draft.site[field.key]} maxLength={SITE_LIMITS[field.key]} onChange={event => updateSite(field.key, event.target.value)}/> : <input value={draft.site[field.key]} maxLength={SITE_LIMITS[field.key]} onChange={event => updateSite(field.key, event.target.value)}/>}</label>)}</div> : <div className="memory-fields" role="tabpanel" aria-label="照片与视频文字">
        <div className="editor-memory-list"><label className="editor-search"><Search size={14}/><input aria-label="搜索回忆" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索编号、标题…"/></label><div className="memory-choices">{visibleItems.map(item => <button className={selectedId === item.id ? 'memory-choice selected' : 'memory-choice'} key={item.id} onClick={() => setSelectedId(item.id)} aria-pressed={selectedId === item.id}><span className="choice-preview"><Thumbnail item={item}/></span><span><strong>{draft.memories[scope][item.id]?.title || item.title || '未命名回忆'}</strong><small>#{String(item.index).padStart(3, '0')} · {item.type === 'video' ? '视频' : '照片'}{draftDates.get(item.id) && ` · ${draftDates.get(item.id)}`}</small></span>{draft.memories[scope][item.id] && <span className="edited-mark" title="已自定义文字"/>}</button>)}{!visibleItems.length && <p className="editor-no-results">没有找到这段回忆</p>}</div></div>
        <div className="editor-memory-detail">{selected && selectedText ? <><div className="editor-photo"><Thumbnail key={selected.id} item={selected}/><span>MEMORY {String(selected.index).padStart(3, '0')}</span></div><label className="editor-field"><span>回忆标题<small>{selectedText.title.length} / {MEMORY_TITLE_LIMIT}</small></span><input value={selectedText.title} maxLength={MEMORY_TITLE_LIMIT} onChange={event => updateMemory('title', event.target.value)}/></label><label className="editor-field"><span>回忆说明<small>{selectedText.subtitle.length} / {MEMORY_SUBTITLE_LIMIT}</small></span><textarea value={selectedText.subtitle} rows={4} maxLength={MEMORY_SUBTITLE_LIMIT} onChange={event => updateMemory('subtitle', event.target.value)}/></label><label className="editor-field"><span>拍摄日期<small>{recordedDate ? `素材记录 ${recordedDate}` : '素材未记录日期'}</small></span><input type="date" value={selectedText.date ?? ''} min="1900-01-01" max="9999-12-31" onChange={event => updateDate(event.target.value)}/></label><p className="memory-edit-note">{isDemo ? '你正在编辑演示素材，文字不会套用到之后放入的个人素材。' : '文字按素材编号保存，更换同编号的图片或视频时会沿用。'}日期留空则使用素材记录，它决定这段回忆在星空中的远近与年份。</p></> : <p className="editor-no-results">选择一段回忆，开始记录。</p>}</div>
      </div>}
    </fieldset>
    <div className="editor-bottom">{error && <p className="editor-feedback error" role="alert"><AlertCircle size={15}/>{error}</p>}{message && <p className="editor-feedback" role="status"><Check size={15}/>{message}</p>}{confirmClose ? <div className="editor-discard"><p>还有未保存的文字，是否放弃本次修改？</p><button className="text-button" onClick={() => setConfirmClose(false)}>继续编辑</button><button className="text-button discard-button" onClick={onClose}>放弃更改并关闭</button></div> : <div className="editor-save-row"><span className={dirty ? 'edit-state dirty' : 'edit-state'}><span className="status-dot"/>{dirty ? '有未保存的修改' : '修改后点击保存'}</span><div><button className="text-button reset-edits" disabled={!dirty || busy} onClick={() => { setDraft(structuredClone(content)); setError(''); setMessage(''); }}>撤销本次修改</button><button className="primary-button" disabled={!dirty || busy} onClick={() => void save()}><Save size={15}/>{busy ? '正在保存…' : storage === 'project' ? '保存到项目' : '保存到本机'}</button></div></div>}</div>
  </Dialog>;
}
