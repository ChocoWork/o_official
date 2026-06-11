import "./PageControl.css";
import type { PageControlProps } from "./PageControl_types";

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

  return (
    <nav
      data-ui-pagecontrol="true"
      data-ui-pagecontrol-size={size}
      data-ui-size={size}
      className={className}
      aria-label="pagination"
    >
      <button
        data-pagecontrol-btn=""
        type="button"
        disabled={page <= firstPage}
        aria-label={previousAriaLabel}
        onClick={() => onPageChange(Math.max(firstPage, page - 1))}
      >
        <i data-pagecontrol-icon="" className="ri-arrow-left-s-line" aria-hidden="true" />
      </button>
      {pages.map((number) => (
        <button
          key={number}
          data-pagecontrol-btn=""
          type="button"
          aria-current={number === page ? 'page' : undefined}
          onClick={() => onPageChange(number)}
        >
          {number}
        </button>
      ))}
      <button
        data-pagecontrol-btn=""
        type="button"
        disabled={page >= lastPage}
        aria-label={nextAriaLabel}
        onClick={() => onPageChange(Math.min(lastPage, page + 1))}
      >
        <i data-pagecontrol-icon="" className="ri-arrow-right-s-line" aria-hidden="true" />
      </button>
    </nav>
  );
}
