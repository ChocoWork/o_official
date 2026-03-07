import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: 'left' | 'right';
  children: ReactNode;
  className?: string;
  size?: ComponentSize;
}

export function Drawer({ open, onClose, side = 'right', children, className, size = 'md' }: DrawerProps) {
  if (!open) {
    return null;
  }

  const widthMap: Record<ComponentSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
  };

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40"></div>
      <aside
        className={cn(
          'absolute top-0 bottom-0 h-full w-full overflow-y-auto bg-white shadow-2xl',
          widthMap[size],
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
