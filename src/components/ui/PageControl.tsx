import { cn } from '@/lib/utils';

import { ComponentSize } from './types';

export interface PageControlProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
  size?: ComponentSize;
}

export function PageControl({
  page,
  totalPages,
  onPageChange,
  className,
  previousAriaLabel = 'Previous page',
  nextAriaLabel = 'Next page',
  size = 'md',
}: PageControlProps) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);
  const firstPage = pages[0] ?? 1;
  const lastPage = pages[pages.length - 1] ?? totalPages;

  // classes derived from size
  const dimensionMap: Record<ComponentSize, string> = {
    sm: 'h-8 w-8',
    md: 'h-10 w-10',
    lg: 'h-12 w-12',
  };
  const textMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };
  const iconMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-base',
    lg: 'text-lg',
  };

  const btnDim = dimensionMap[size];
  const pageText = textMap[size];
  const iconText = iconMap[size];

  return (
    <nav className={cn('flex items-center justify-center gap-2', className)} aria-label="pagination">
      <button
        type="button"
        disabled={page <= firstPage}
        aria-label={previousAriaLabel}
        onClick={() => onPageChange(Math.max(firstPage, page - 1))}
        className={cn('flex items-center justify-center border border-black/20 transition-colors hover:bg-[#f5f5f5] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', btnDim)}
      >
        <span className={cn('flex items-center justify-center', btnDim)}>
          <i className={cn('ri-arrow-left-s-line', iconText)}></i>
        </span>
      </button>
      {pages.map((number) => (
        <button
          key={number}
          type="button"
          onClick={() => onPageChange(number)}
          aria-current={number === page ? 'page' : undefined}
          className={cn(
            'flex items-center justify-center transition-colors cursor-pointer',
            btnDim,
            pageText,
            number === page ? 'bg-black text-white' : 'border border-black/20 hover:bg-[#f5f5f5]',
          )}
        >
          {number}
        </button>
      ))}
      <button
        type="button"
        disabled={page >= lastPage}
        aria-label={nextAriaLabel}
        onClick={() => onPageChange(Math.min(lastPage, page + 1))}
        className={cn('flex items-center justify-center border border-black/20 transition-colors hover:bg-[#f5f5f5] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', btnDim)}
      >
        <span className={cn('flex items-center justify-center', btnDim)}>
          <i className={cn('ri-arrow-right-s-line', iconText)}></i>
        </span>
      </button>
    </nav>
  );
}
