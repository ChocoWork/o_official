"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    onTurnstileSuccess?: (token: string) => void;
    turnstile?: {
      render: (
        element: HTMLElement,
        options: { sitekey: string; size?: 'normal' | 'compact' | 'flexible'; callback: (token: string) => void },
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

/**
 * Cloudflare Turnstile ウィジェットを明示的にレンダリングするフック。
 * 自動レンダリング（class="cf-turnstile"）はスクリプト読み込み時にしか走らないため、
 * タブ切り替え等でコンポーネントが再マウントされるとウィジェットが表示されない。
 * containerRef を対象の div に、renderWidget を Script の onReady に渡すこと。
 * window.onTurnstileSuccess は E2E テストがトークンを注入するためのフック。
 */

// Turnstile の iframe は幅 300px を下回れない。size:'flexible' はコンテナ幅に追従するが、
// それも 300px までで、それより狭いコンテナでは溢れて隣接要素の幅まで押し広げる。
const TURNSTILE_MIN_WIDTH = 300;

export function useTurnstileWidget(siteKey: string, onToken: (token: string) => void) {
  // コンテナは条件付きレンダリングで付け外しされることがある（例: 送信完了画面から
  // 再送信へ戻る）。RefObject だと要素が差し替わっても effect の依存が変わらず、
  // 新しい要素にウィジェットも採寸も付かないまま残るため、state を持つ callback ref にする。
  // node は ref と state の両方で持つ。renderWidget は Script の onReady が
  // 初回レンダー時の関数を掴んだままなので identity を変えられない（変えると
  // 掴まれた側が container 未設定のまま早期 return し、ウィジェットが出ない）。
  // 一方で要素の差し替えには effect が反応する必要があるため、state も置く。
  const containerNodeRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    containerNodeRef.current = node;
    setContainer(node);
  }, []);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const renderWidget = useCallback(() => {
    const node = containerNodeRef.current;
    if (!siteKey || !node || widgetIdRef.current !== null || !window.turnstile) return;
    widgetIdRef.current = window.turnstile.render(node, {
      sitekey: siteKey,
      size: 'flexible',
      callback: (token) => onTokenRef.current(token),
    });
  }, [siteKey]);

  useEffect(() => {
    if (!siteKey) return;
    window.onTurnstileSuccess = (token: string) => onTokenRef.current(token);
    return () => {
      if (window.onTurnstileSuccess) {
        delete window.onTurnstileSuccess;
      }
    };
  }, [siteKey]);

  /**
   * ウィジェットを引き直して新しいトークンを発行させる。
   *
   * Turnstile のトークンは siteverify が引き換えた時点で無効になる（使い捨て）。
   * 送信のたびに呼ばないと、2 回目の送信が timeout-or-duplicate で弾かれ、
   * サーバーからは Bot 検証失敗（403）として返る。成否によらずトークンは
   * 消費されるので、失敗して同じ画面に留まるときこそ呼ぶ必要がある。
   */
  const resetWidget = useCallback(() => {
    onTokenRef.current('');
    if (widgetIdRef.current === null) return;
    window.turnstile?.reset(widgetIdRef.current);
  }, []);

  // container を依存に含めて、要素が差し替わったら描画し直す。
  useEffect(() => {
    renderWidget();
    return () => {
      if (widgetIdRef.current !== null) {
        window.turnstile?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget, container]);

  // コンテナが 300px 未満のときだけ等倍縮小して収める。
  // 収めないとフォーム内のグリッド列が 300px に広がり、送信ボタンだけが
  // Google ボタンより横に張り出す（iPhone SE 幅で顕著）。
  useEffect(() => {
    if (!siteKey || !container) return;

    // grid/flex 項目の min-width:auto は中身の最小幅（300px）を親へ伝播させるため、
    // これを切らないとコンテナ自身が 300px に膨らみ、利用可能幅を測れない（循環する）。
    container.style.overflow = 'hidden';
    container.style.minWidth = '0';

    let observedWidget: HTMLElement | null = null;

    const fit = () => {
      const widget = container.firstElementChild as HTMLElement | null;
      if (!widget) return;

      // ウィジェットは iframe を非同期に読み込む。高さが確定する前に採寸すると
      // container の高さを 0 で固定してしまい、以後見た目が出ない。
      const naturalHeight = widget.offsetHeight;
      const available = container.clientWidth;
      if (naturalHeight === 0 || available === 0) return;

      if (widget !== observedWidget) {
        if (observedWidget) resizeObserver.unobserve(observedWidget);
        resizeObserver.observe(widget);
        observedWidget = widget;
      }

      const scale = Math.min(1, available / TURNSTILE_MIN_WIDTH);
      const height = `${naturalHeight * scale}px`;
      widget.style.transformOrigin = '0 0';
      widget.style.transform = scale === 1 ? '' : `scale(${scale})`;
      if (container.style.height !== height) container.style.height = height;
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(container);
    const mutationObserver = new MutationObserver(fit);
    mutationObserver.observe(container, { childList: true });
    fit();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [siteKey, container]);

  return { containerRef, renderWidget, resetWidget };
}
