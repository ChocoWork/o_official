"use client";

import { useCallback, useEffect, useRef } from 'react';

declare global {
  interface Window {
    onTurnstileSuccess?: (token: string) => void;
    turnstile?: {
      render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => string;
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
export function useTurnstileWidget(siteKey: string, onToken: (token: string) => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const renderWidget = useCallback(() => {
    const container = containerRef.current;
    if (!siteKey || !container || widgetIdRef.current !== null || !window.turnstile) return;
    widgetIdRef.current = window.turnstile.render(container, {
      sitekey: siteKey,
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

  useEffect(() => {
    renderWidget();
    return () => {
      if (widgetIdRef.current !== null) {
        window.turnstile?.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget]);

  return { containerRef, renderWidget };
}
