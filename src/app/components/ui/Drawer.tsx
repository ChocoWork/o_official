import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  children: ReactNode;
  className?: string;
}

export function Drawer({ open, onClose, side = 'right', children, className }: DrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40"></div>
      <aside
        className={cn(
          'absolute top-0 bottom-0 h-full w-full max-w-md overflow-y-auto bg-white shadow-2xl',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </aside>
    </div>
  );
}
