'use client';

import "./Sheet.css";
import { useEffect, useId, useRef } from "react";
import type { SheetProps } from "./Sheet_type";

export type { SheetProps, SheetSize } from "./Sheet_type";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  title,
  children,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: SheetProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // モーダルとして開いている間は、背景のスクロールを止めて誤操作を防ぐ
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Escape で閉じ、Tab はシート内で循環させる（フォーカストラップ）。
  // 閉じたあとは開く操作をした要素へフォーカスを戻す。
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-ui-sheet=""
      data-ui-size={size}
      onClick={onClose}
    >
      <div data-ui-sheet-backdrop="" aria-hidden="true" />
      <aside
        ref={panelRef}
        data-ui-sheet-panel=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={className}
        onClick={(e) => e.stopPropagation()}
      >
        <div data-ui-sheet-header="">
          {title ? (
            <h3 data-ui-sheet-title="" id={titleId}>
              {title}
            </h3>
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
