import "./PageControl.css";
import type { PageControlProps } from "./PageControl_types";

type PageSlot = number | "ellipsis";

/**
 * 描くページ番号を決める。maxVisiblePages を超えたときだけ間を「…」で畳む。
 * 先頭・末尾は常に残す（総量と現在地の見当が付かなくなるため）。
 */
function buildSlots(
  page: number,
  totalPages: number,
  maxVisiblePages?: number,
): PageSlot[] {
  const all = Array.from({ length: totalPages }, (_, index) => index + 1);
  if (!maxVisiblePages || maxVisiblePages < 3 || totalPages <= maxVisiblePages) {
    return all;
  }

  // 末尾ページぶんを除いた枠を、現在地のある側へ寄せて使う。
  const edge = maxVisiblePages - 1;
  if (page <= edge - 1) {
    return [...all.slice(0, edge), "ellipsis", totalPages];
  }
  if (page >= totalPages - edge + 2) {
    return [1, "ellipsis", ...all.slice(totalPages - edge)];
  }
  const windowSize = Math.max(1, maxVisiblePages - 2);
  const start = Math.min(
    Math.max(2, page - Math.floor((windowSize - 1) / 2)),
    totalPages - windowSize,
  );
  return [
    1,
    "ellipsis",
    ...all.slice(start - 1, start - 1 + windowSize),
    "ellipsis",
    totalPages,
  ];
}

export function PageControl({
  page,
  totalPages,
  onPageChange,
  className,
  previousAriaLabel = 'Previous page',
  nextAriaLabel = 'Next page',
  size = 'md',
  maxVisiblePages,
}: PageControlProps) {
  const firstPage = 1;
  const lastPage = Math.max(1, totalPages);
  const slots = buildSlots(page, lastPage, maxVisiblePages);

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
      {slots.map((slot, index) =>
        slot === 'ellipsis' ? (
          <span
            key={`ellipsis-${index}`}
            data-pagecontrol-ellipsis=""
            aria-hidden="true"
          >
            …
          </span>
        ) : (
          <button
            key={slot}
            data-pagecontrol-btn=""
            type="button"
            aria-current={slot === page ? 'page' : undefined}
            onClick={() => onPageChange(slot)}
          >
            {slot}
          </button>
        ),
      )}
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
