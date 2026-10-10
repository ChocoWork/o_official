// File: src/components/ui/Dialog/Dialog.tsx
"use client";

import "@/components/ui/Dialog/Dialog.css";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button/Button";
import { cn } from "@/lib/utils";
import type { DialogProps } from "@/components/ui/Dialog/Dialog_types";

// Tab で止まる要素（Sheet と同じ選び方。hidden の input にはフォーカスが移らないので除く）
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// hidden 属性・display:none・visibility:hidden の要素にはフォーカスが移らない。
// レイアウト（offsetParent）ではなく計算済みのスタイルで見るので、jsdom でも同じに動く
function isRendered(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === "none") {
      return false;
    }
  }
  return getComputedStyle(element).visibility !== "hidden";
}

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isRendered);
}

export function Dialog({
  open,
  onClose,
  title = "Dialog Title",
  description,
  cancelText = "CANCEL",
  confirmText = "CONFIRM",
  onConfirm,
  children,
  className,
  shape = "square",
  size = "md",
  fullScreenOnMobile = false,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 親は onClose を描画のたびにつくり直す（入力のたびに再描画する）。effect の依存にすると
  // そのたびにフォーカスを最初の要素へ奪い直してしまうので、最新の onClose だけ ref で持つ
  const onCloseRef = useRef(onClose);
  // 押した位置か離した位置のどちらかがパネルの中なら、その click では背景を押したことにしない
  const pointerInPanelRef = useRef(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // aria-modal="true" を名乗るので、開いている間はフォーカスを中に閉じ込める。
  // 開いたら中へ移し、Tab は中で循環させ、Escape で閉じ、閉じたら開く前の要素へ戻す
  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    // 開く前にフォーカスがあった要素（閉じたら戻す）。すでに中にある（autoFocus）なら戻し先が分からない
    const previous = document.activeElement;
    const opener = previous instanceof HTMLElement && !panel.contains(previous) ? previous : null;
    if (!panel.contains(previous)) {
      (focusableIn(panel)[0] ?? panel).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // 中の部品が処理済みの Escape（SingleSelect が一覧だけ閉じる等）と、日本語入力の変換中は何もしない
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const items = focusableIn(panel);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const current = document.activeElement;
      // パネルの外（クリックで body に外れた等）やパネル自身にあるときも、端と同じく中へ戻す
      const inside = current !== panel && panel.contains(current);
      if (event.shiftKey) {
        if (!inside || current === items[0]) {
          event.preventDefault();
          items[items.length - 1].focus();
        }
      } else if (!inside || current === items[items.length - 1]) {
        event.preventDefault();
        items[0].focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const rootDataAttrs = {
    "data-ui-dialog": "true",
    "data-ui-dialog-shape": shape,
    "data-ui-dialog-size": size,
    "data-ui-size": size,
    "data-ui-dialog-fullscreen": fullScreenOnMobile ? "mobile" : undefined,
  } as const;

  const isInPanel = (target: EventTarget) =>
    target instanceof Node && panelRef.current?.contains(target) === true;

  // 押した所か離した所がパネルの中だった click では閉じない。パネルの中で文字の選択を始めて背景で離すと、
  // ブラウザは押した所と離した所の共通の親（この overlay）へ click を送るので、それで閉じて入力を失わない。
  // 押下の記録が無い click（プログラムからの click など）は、背景の click として閉じる
  return (
    <div
      className="dialog-overlay"
      onPointerDown={(event) => {
        pointerInPanelRef.current = isInPanel(event.target);
      }}
      onPointerUp={(event) => {
        if (isInPanel(event.target)) {
          pointerInPanelRef.current = true;
        }
      }}
      onClick={() => {
        const startedOrEndedInPanel = pointerInPanelRef.current;
        pointerInPanelRef.current = false;
        if (!startedOrEndedInPanel) {
          onClose();
        }
      }}
      role="presentation"
      {...rootDataAttrs}
    >
      <div className="dialog-overlay__scrim" aria-hidden="true" />
      <div
        ref={panelRef}
        className={cn("dialog-panel", className)}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="dialog-panel__body">
          <h3 className="dialog-panel__title">{title}</h3>
          {description ? (
            <p className="dialog-panel__description">{description}</p>
          ) : null}
          {children ? (
            <div className="dialog-panel__content">{children}</div>
          ) : (
            <div className="dialog-panel__actions">
              <Button
                type="button"
                variant="secondary"
                size={size}
                className="dialog-panel__action"
                onClick={onClose}
              >
                {cancelText}
              </Button>
              <Button
                type="button"
                size={size}
                className="dialog-panel__action"
                onClick={() => {
                  onConfirm?.();
                  onClose();
                }}
              >
                {confirmText}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
