import type { ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute -top-2 left-1/2 z-40 hidden -translate-x-1/2 -translate-y-full whitespace-nowrap border border-black/10 bg-black px-2 py-1 text-xs text-white group-hover:block">
        {content}
      </span>
    </span>
  );
}
