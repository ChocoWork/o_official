import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  children: ReactNode;
}

export function Drawer({ open, onClose, side = 'right', children }: DrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <aside
        className={cn(
          'absolute top-0 h-full w-full max-w-md border-black/10 bg-white p-6 shadow-sm',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </aside>
    </div>
  );
}
