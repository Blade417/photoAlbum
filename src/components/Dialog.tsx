import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({ children, label, onClose, className = '' }: { children: ReactNode; label: string; onClose: () => void; className?: string }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current!;
    root.querySelector<HTMLElement>('button')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const nodes = [...root.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, video[controls], [tabindex="0"]')].filter(el => !el.matches(':disabled') && el.getClientRects().length);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className={`dialog-backdrop ${className}`} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <button className="icon-button dialog-close" aria-label="关闭" onClick={onClose}><X size={21}/></button>
      {children}
    </div>
  </div>;
}
