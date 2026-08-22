"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ScrollRevealProps {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/**
 * hyke.jp（common.js の setCover / actRiseup）と同じ考え方のリビール。
 * 配下の .reveal-cover（画像）と .reveal-mask（文字）を *それぞれ別に* 監視し、
 * その要素自身がビューポートに入ったら data-reveal="true" を立てる。
 * カード単位で1つ監視すると、カード上端が入った時点で下端の文字まで動き出し、
 * 文字が画面に入る前にモーションが終わってしまうため。
 *
 * 監視するのは中の .reveal-rise ではなくマスクの .reveal-mask。
 * .reveal-rise は translateY(105%) でマスクの外にあり可視面積が常に 0 のため、
 * 直接監視すると永久に発火しない。参考先も監視対象はマスク側。
 *
 * 画像を含む対象は、読み込みが完了してから監視を始める。
 * 空の枠だけカバーが開くのを避けるため（2枚目以降は待たない）。
 */
export default function ScrollReveal({
  children,
  className,
  "data-testid": dataTestId,
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const observers: IntersectionObserver[] = [];
    const cleanups: (() => void)[] = [];

    root
      .querySelectorAll<HTMLElement>(".reveal-cover, .reveal-mask")
      .forEach((el) => {
        const observe = () => {
          const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              el.setAttribute("data-reveal", "true");
              observer.disconnect();
            });
          });
          observer.observe(el);
          observers.push(observer);
        };

        const img = el.querySelector("img");
        if (!img || img.complete) {
          observe();
          return;
        }
        img.addEventListener("load", observe, { once: true });
        img.addEventListener("error", observe, { once: true });
        cleanups.push(() => {
          img.removeEventListener("load", observe);
          img.removeEventListener("error", observe);
        });
      });

    return () => {
      observers.forEach((observer) => observer.disconnect());
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  return (
    <div ref={ref} className={className} data-testid={dataTestId} data-reveal-group="">
      {children}
    </div>
  );
}
