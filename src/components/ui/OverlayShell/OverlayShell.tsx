import "./OverlayShell.css";
import type { BaseOverlayProps } from "./OverlayShell_types";

export type { BaseOverlayProps } from "./OverlayShell_types";

export function OverlayShell({ open, onClose, title, children, className, size = 'md' }: BaseOverlayProps) {
  if (!open) return null;

  return (
    <div data-ui-overlay="" data-ui-size={size}>
      <div data-ui-overlay-panel="" className={className}>
        <div data-overlay-header="">
          {title ? (
            <h3 data-overlay-title="">{title}</h3>
          ) : (
            <span aria-hidden="true" />
          )}
          <button
            data-overlay-close=""
            type="button"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
