'use client';

import { useLayoutEffect, useRef } from "react";
import "./Slider.css";
import type { SliderProps } from "./Slider_type";

export type { SliderProps, SliderMode } from "./Slider_type";

// ── 内部ユーティリティ ──────────────────────────────────────────

type NumericInput = number | string | undefined;

function toFiniteNumber(value: NumericInput, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSliderBounds(min: NumericInput, max: NumericInput) {
  const a = toFiniteNumber(min, 0);
  const b = toFiniteNumber(max, 100);
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

function normalizeStep(step: NumericInput): number {
  const s = toFiniteNumber(step, 1);
  return s > 0 ? s : 1;
}

function buildSliderStops(min: number, max: number, step: number): number[] {
  if (max <= min) return [min];
  const precision = String(step).includes('.')
    ? (String(step).split('.')[1]?.length ?? 0)
    : 0;
  const round = (v: number) => Number(v.toFixed(precision));
  const first = round(Math.ceil(min / step) * step);
  const stops = [min];
  for (let cur = first; cur < max; cur = round(cur + step)) {
    if (cur > min) stops.push(cur);
  }
  if (stops[stops.length - 1] !== max) stops.push(max);
  return Array.from(new Set(stops)).sort((a, b) => a - b);
}

function findClosestStopIndex(value: number, stops: number[]): number {
  let idx = 0;
  let minDist = Infinity;
  for (const [i, stop] of stops.entries()) {
    const d = Math.abs(stop - value);
    if (d < minDist) { idx = i; minDist = d; }
  }
  return idx;
}

/*
 * トラックを Blink のペイントグリッドへスナップする。
 *
 * 分数DPR（Windows 125/150/175% スケーリング）では、Blink は塗りを
 * [round(cssTop), round(cssTop)+h] × DPR で描画する（実測で確認）。
 * cssTop の整数部 × DPR が非整数だと上下端がサブピクセルAAでにじみ、
 * ページ上の Y 位置が異なる single / range で太さが違って見える。
 *
 * 対策: q×DPR が整数になる最小の q を求め、トラックの cssTop を
 * q の倍数（ナッジ ≤ ±q/2 px）へ margin-top で寄せる。これで描画帯の
 * デバイス行パターンが Y 位置に依存しなくなり、両者は常に同一の太さになる。
 * サムとのセンター一致を保つため input にも同じ delta を適用する。
 * JS 無効時は CSS の translateY(-50%) センタリングのまま（従来動作）。
 */
function useTrackPaintSnap(size: string) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const snap = () => {
      const track = wrap.querySelector<HTMLElement>('[data-ui-slider-track]');
      if (!track) return;
      const dpr = window.devicePixelRatio || 1;
      let q = 1;
      for (const c of [1, 2, 4, 5, 8]) {
        if (Math.abs(c * dpr - Math.round(c * dpr)) < 1e-6) { q = c; break; }
      }
      // 基準状態（transform なし・margin で中央寄せ）に戻してから1回だけ測って適用
      const h = track.getBoundingClientRect().height;
      track.style.transform = 'none';
      track.style.marginTop = `${-h / 2}px`;
      const top = track.getBoundingClientRect().top;
      const delta = Math.round(top / q) * q - top;
      track.style.marginTop = `${-h / 2 + delta}px`;
      for (const input of wrap.querySelectorAll<HTMLElement>('input[type="range"]')) {
        input.style.marginTop = `${delta}px`;
      }
    };

    snap();
    window.addEventListener('resize', snap);
    window.addEventListener('scrollend', snap);
    return () => {
      window.removeEventListener('resize', snap);
      window.removeEventListener('scrollend', snap);
    };
  }, [size]);

  return wrapRef;
}

// ── コンポーネント ──────────────────────────────────────────────

export function Slider({
  label,
  className,
  mode = 'single',
  value,
  onValueChange,
  rangeValue,
  onRangeChange,
  valueDisplay,
  min = 0,
  max = 100,
  step = 1,
  size = 'md',
  ...props
}: SliderProps) {
  const { min: resolvedMin, max: resolvedMax } = normalizeSliderBounds(min, max);
  const resolvedStep = normalizeStep(step);
  const stops = buildSliderStops(resolvedMin, resolvedMax, resolvedStep);
  const stopCount = Math.max(stops.length - 1, 0);
  const trackWrapRef = useTrackPaintSnap(size);

  const header = (label || valueDisplay) ? (
    <div data-ui-slider-header="">
      {label
        ? <span data-ui-slider-label="">{label}</span>
        : <span aria-hidden="true" />}
      {valueDisplay && <span data-ui-slider-value="">{valueDisplay}</span>}
    </div>
  ) : null;

  // ── range モード ──────────────────────────────────────────────
  if (mode === 'range' && rangeValue && onRangeChange) {
    const lo = Math.min(rangeValue[0], rangeValue[1]);
    const hi = Math.max(rangeValue[0], rangeValue[1]);
    const minIdx = Math.min(
      findClosestStopIndex(lo, stops),
      findClosestStopIndex(hi, stops),
    );
    const maxIdx = Math.max(
      findClosestStopIndex(lo, stops),
      findClosestStopIndex(hi, stops),
    );
    const curMin = stops[minIdx] ?? resolvedMin;
    const curMax = stops[maxIdx] ?? resolvedMax;
    const fillStart = stopCount === 0 ? 0 : (minIdx / stopCount) * 100;
    const fillWidth  = stopCount === 0 ? 0 : ((maxIdx - minIdx) / stopCount) * 100;

    return (
      <div data-ui-slider="" data-ui-size={size} className={className}>
        {header}
        <div ref={trackWrapRef} data-ui-slider-track-wrap="" data-testid="price-range-track-wrap">
          <div data-ui-slider-track="" data-testid="price-range-track">
            <div
              data-ui-slider-fill=""
              data-testid="price-range-fill"
              style={{ left: `${fillStart}%`, width: `${fillWidth}%` }}
            />
          </div>
          <input
            type="range"
            min={0} max={stopCount} step={1}
            value={minIdx}
            data-ui-slider-range-input=""
            data-ui-range-role="min"
            aria-label="Minimum value"
            aria-valuemin={resolvedMin}
            aria-valuemax={resolvedMax}
            aria-valuenow={curMin}
            aria-valuetext={String(curMin)}
            onChange={(e) => {
              const next = Math.min(Number(e.target.value), maxIdx);
              onRangeChange([stops[next] ?? curMin, curMax]);
            }}
          />
          <input
            type="range"
            min={0} max={stopCount} step={1}
            value={maxIdx}
            data-ui-slider-range-input=""
            data-ui-range-role="max"
            aria-label="Maximum value"
            aria-valuemin={resolvedMin}
            aria-valuemax={resolvedMax}
            aria-valuenow={curMax}
            aria-valuetext={String(curMax)}
            onChange={(e) => {
              const next = Math.max(Number(e.target.value), minIdx);
              onRangeChange([curMin, stops[next] ?? curMax]);
            }}
          />
        </div>
      </div>
    );
  }

  // ── single モード ─────────────────────────────────────────────
  const range = Math.max(resolvedMax - resolvedMin, 1);
  const fillPct = typeof value === 'number'
    ? Math.max(0, Math.min(100, (value - resolvedMin) / range * 100))
    : 0;

  return (
    <div data-ui-slider="" data-ui-size={size}>
      {header}
      <div ref={trackWrapRef} data-ui-slider-track-wrap="">
        <div data-ui-slider-track="">
          <div data-ui-slider-fill="" style={{ width: `${fillPct}%` }} />
        </div>
        <input
          type="range"
          min={resolvedMin}
          max={resolvedMax}
          step={resolvedStep}
          value={value}
          data-ui-slider-input=""
          className={className}
          onChange={(e) => {
            onValueChange?.(Number(e.target.value));
            props.onChange?.(e);
          }}
          {...props}
        />
      </div>
    </div>
  );
}
