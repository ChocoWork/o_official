import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function Tooltip({ content, children, className, contentClassName }: TooltipProps) {
  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        className={cn(
          'pointer-events-none absolute bottom-full left-1/2 z-40 mb-2 hidden -translate-x-1/2 whitespace-nowrap bg-black px-4 py-2 text-xs text-white group-hover:block group-focus-within:block',
          contentClassName,
        )}
        style={{ fontFamily: 'acumin-pro, sans-serif' }}
      >
        {content}
        <span className="absolute top-full left-1/2 h-0 w-0 -translate-x-1/2 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-black"></span>
      </span>
    </span>
  );
}
