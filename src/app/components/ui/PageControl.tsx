import { cn } from '@/lib/utils';

export interface PageControlProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
}

export function PageControl({
  page,
  totalPages,
  onPageChange,
  className,
  previousAriaLabel = 'Previous page',
  nextAriaLabel = 'Next page',
}: PageControlProps) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);
  const firstPage = pages[0] ?? 1;
  const lastPage = pages[pages.length - 1] ?? totalPages;

  return (
    <nav className={cn('flex items-center justify-center gap-2', className)} aria-label="pagination">
      <button
        type="button"
        disabled={page <= firstPage}
        aria-label={previousAriaLabel}
        onClick={() => onPageChange(Math.max(firstPage, page - 1))}
        className="flex h-10 w-10 items-center justify-center border border-black/20 transition-colors hover:bg-[#f5f5f5] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="flex h-4 w-4 items-center justify-center">
          <i className="ri-arrow-left-s-line text-base"></i>
        </span>
      </button>
      {pages.map((number) => (
        <button
          key={number}
          type="button"
          onClick={() => onPageChange(number)}
          aria-current={number === page ? 'page' : undefined}
          className={cn(
            'flex h-10 w-10 items-center justify-center text-sm transition-colors cursor-pointer',
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
        className="flex h-10 w-10 items-center justify-center border border-black/20 transition-colors hover:bg-[#f5f5f5] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="flex h-4 w-4 items-center justify-center">
          <i className="ri-arrow-right-s-line text-base"></i>
        </span>
      </button>
    </nav>
  );
}
