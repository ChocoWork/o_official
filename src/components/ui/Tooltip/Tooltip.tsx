import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from '../types';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** ツールチップのサイズ。sm/md/lg。デフォルトは 'md'。 */
  size?: ComponentSize;
}

export function Tooltip({ content, children, className, contentClassName, size = 'md' }: TooltipProps) {
  // size maps
  const paddingMap: Record<ComponentSize, string> = {
    xs: 'px-2 py-1',
    sm: 'px-2 py-1',
    md: 'px-4 py-2',
    lg: 'px-6 py-3',
    xl: 'px-6 py-3',
  };
  const textMap: Record<ComponentSize, string> = {
    xs: 'text-[10px]',
    sm: 'text-[10px]',
    md: 'text-xs',
    lg: 'text-sm',
    xl: 'text-sm',
  };
  const arrowMap: Record<ComponentSize, string> = {
    xs: 'border-l-3 border-r-3 border-t-3',
    sm: 'border-l-3 border-r-3 border-t-3',
    md: 'border-l-4 border-r-4 border-t-4',
    lg: 'border-l-5 border-r-5 border-t-5',
    xl: 'border-l-5 border-r-5 border-t-5',
  };

  const pad = paddingMap[size];
  const textSz = textMap[size];
  const arrowSz = arrowMap[size];

  return (
    <span className={cn('group relative inline-flex', className)}>
      {children}
      <span
        className={cn(
          'pointer-events-none absolute bottom-full left-1/2 z-40 mb-2 hidden -translate-x-1/2 whitespace-nowrap bg-black text-white group-hover:block group-focus-within:block',
          pad,
          textSz,
          contentClassName,
        )}
        style={{ fontFamily: 'acumin-pro, sans-serif' }}
      >
        {content}
        <span className={cn(
          'absolute top-full left-1/2 h-0 w-0 -translate-x-1/2 border-l-transparent border-r-transparent border-t-black',
          arrowSz,
        )}></span>
      </span>
    </span>
  );
}
