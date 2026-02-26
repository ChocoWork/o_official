import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface ToolbarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function Toolbar({ left, center, right, className }: ToolbarProps) {
  return (
    <header className={cn('flex items-center justify-between border-b border-black/10 bg-white px-4 py-3', className)}>
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      <div className="flex min-w-0 flex-1 items-center justify-center">{center}</div>
      <div className="flex min-w-0 items-center justify-end gap-2">{right}</div>
    </header>
  );
}
