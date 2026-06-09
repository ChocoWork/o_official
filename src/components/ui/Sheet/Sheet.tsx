import "./Sheet.css";
import type { SheetProps } from "./Sheet_type";

export type { SheetProps, SheetSize } from "./Sheet_type";

export function Sheet({
  open,
  onClose,
  title,
  children,
  size = 'md',
  className,
}: SheetProps) {
  if (!open) return null;

  return (
    <div
      data-ui-sheet=""
      data-ui-size={size}
      onClick={onClose}
    >
      <div data-ui-sheet-backdrop="" aria-hidden="true" />
      <aside
        data-ui-sheet-panel=""
        className={className}
        onClick={(e) => e.stopPropagation()}
      >
        <div data-ui-sheet-header="">
          {title ? (
            <h3 data-ui-sheet-title="">{title}</h3>
          ) : (
            <span aria-hidden="true" />
          )}
          <button
            type="button"
            data-ui-sheet-close=""
            onClick={onClose}
            aria-label="close"
          >
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}
