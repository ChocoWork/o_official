import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface BaseOverlayProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

export function OverlayShell({ open, onClose, title, children, className }: BaseOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className={cn('w-full max-w-xl border border-black/10 bg-white p-6', className)}>
        <div className="mb-4 flex items-center justify-between">
          {title ? <h3 className="text-lg tracking-tight text-black">{title}</h3> : <span />}
          <button type="button" onClick={onClose} className="text-xl text-[#474747] hover:text-black" aria-label="close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
