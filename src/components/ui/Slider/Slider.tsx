import "./Slider.css"
import { cn } from '@/lib/utils';
import type { InputHTMLAttributes } from 'react';
import { ComponentSize } from '../types';

type NumericInput = number | string | undefined;

function toFiniteNumber(value: NumericInput, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeSliderBounds(minValue: NumericInput, maxValue: NumericInput): { min: number; max: number } {
  const resolvedMin = toFiniteNumber(minValue, 0);
  const resolvedMax = toFiniteNumber(maxValue, 100);

  if (resolvedMin <= resolvedMax) {
    return { min: resolvedMin, max: resolvedMax };
  }

  return { min: resolvedMax, max: resolvedMin };
}

function normalizeStep(stepValue: NumericInput): number {
  const resolvedStep = toFiniteNumber(stepValue, 1);
  return resolvedStep > 0 ? resolvedStep : 1;
}

function buildSliderStops(minValue: number, maxValue: number, stepValue: number): number[] {
  if (maxValue <= minValue) {
    return [minValue];
  }

  const precision = Math.max(
    0,
    String(stepValue).includes('.') ? String(stepValue).split('.')[1]?.length ?? 0 : 0,
  );
  const roundValue = (value: number) => Number(value.toFixed(precision));
  const firstStepValue = roundValue(Math.ceil(minValue / stepValue) * stepValue);
  const stops = [minValue];

  for (let current = firstStepValue; current < maxValue; current = roundValue(current + stepValue)) {
    if (current > minValue) {
      stops.push(current);
    }
  }

  if (stops[stops.length - 1] !== maxValue) {
    stops.push(maxValue);
  }

  return Array.from(new Set(stops)).sort((left, right) => left - right);
}

function findClosestStopIndex(value: number, stops: number[]): number {
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const [index, stop] of stops.entries()) {
    const distance = Math.abs(stop - value);
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }

  return closestIndex;
}

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  mode?: 'single' | 'range';
  value?: number;
  onValueChange?: (value: number) => void;
  rangeValue?: [number, number];
  onRangeChange?: (value: [number, number]) => void;
  valueDisplay?: string;
  size?: ComponentSize;
}

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
  const sliderHeight = size === 'sm' ? 'h-1' : size === 'lg' ? 'h-3' : 'h-2';
  const rangeThumbOffsetClass = 'left-[-4px] w-[calc(100%+8px)]';
  const { min: resolvedMin, max: resolvedMax } = normalizeSliderBounds(min, max);
  const resolvedStep = normalizeStep(step);
  const sliderStops = buildSliderStops(resolvedMin, resolvedMax, resolvedStep);
  const stopCount = Math.max(sliderStops.length - 1, 0);

  if (mode === 'range' && rangeValue && onRangeChange) {
    const rangeMin = Math.min(rangeValue[0], rangeValue[1]);
    const rangeMax = Math.max(rangeValue[0], rangeValue[1]);
    const minIndex = findClosestStopIndex(rangeMin, sliderStops);
    const maxIndex = findClosestStopIndex(rangeMax, sliderStops);
    const clampedMinIndex = Math.min(minIndex, maxIndex);
    const clampedMaxIndex = Math.max(minIndex, maxIndex);
    const currentMinValue = sliderStops[clampedMinIndex] ?? resolvedMin;
    const currentMaxValue = sliderStops[clampedMaxIndex] ?? resolvedMax;
    const fillStart = stopCount === 0 ? 0 : (clampedMinIndex / stopCount) * 100;
    const fillWidth = stopCount === 0 ? 0 : ((clampedMaxIndex - clampedMinIndex) / stopCount) * 100;

    return (
      <div className={cn('space-y-4', className)}>
        {(label || valueDisplay) ? (
          <div className="flex items-center justify-between">
            {label ? <span className="text-xs tracking-widest text-black/80">{label}</span> : <span></span>}
            {valueDisplay ? <span className="text-sm text-black">{valueDisplay}</span> : null}
          </div>
        ) : null}
        <div className={`relative ${sliderHeight}`} data-testid="price-range-track-wrap">
          <div
            className="absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 overflow-hidden rounded-full bg-black/20"
            data-testid="price-range-track"
          >
            <div
              data-testid="price-range-fill"
              className="absolute inset-y-0 rounded-full bg-black"
              style={{ left: `${fillStart}%`, width: `${fillWidth}%` }}
            />
          </div>
          <input
            min={0}
            max={stopCount}
            className={`pointer-events-none absolute ${rangeThumbOffsetClass} top-1/2 z-20 h-4 -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer`}
            type="range"
            step={1}
            value={clampedMinIndex}
            aria-label="Minimum value"
            aria-valuemin={resolvedMin}
            aria-valuemax={resolvedMax}
            aria-valuenow={currentMinValue}
            aria-valuetext={String(currentMinValue)}
            onChange={(event) => {
              const nextIndex = Number(event.target.value);
              const boundedIndex = Math.min(nextIndex, clampedMaxIndex);
              onRangeChange([
                sliderStops[boundedIndex] ?? currentMinValue,
                currentMaxValue,
              ]);
            }}
          />
          <input
            min={0}
            max={stopCount}
            className={`pointer-events-none absolute ${rangeThumbOffsetClass} top-1/2 z-30 h-4 -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer`}
            type="range"
            step={1}
            value={clampedMaxIndex}
            aria-label="Maximum value"
            aria-valuemin={resolvedMin}
            aria-valuemax={resolvedMax}
            aria-valuenow={currentMaxValue}
            aria-valuetext={String(currentMaxValue)}
            onChange={(event) => {
              const nextIndex = Number(event.target.value);
              const boundedIndex = Math.max(nextIndex, clampedMinIndex);
              onRangeChange([
                currentMinValue,
                sliderStops[boundedIndex] ?? currentMaxValue,
              ]);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(label || valueDisplay) ? (
        <div className="flex items-center justify-between">
          {label ? <span className="text-xs tracking-widest text-black/80">{label}</span> : <span></span>}
          {valueDisplay ? <span className="text-sm text-black">{valueDisplay}</span> : null}
        </div>
      ) : null}
      <input
        type="range"
        className={cn(
          'h-1 w-full cursor-pointer appearance-none rounded-full bg-black/20 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer',
          className,
        )}
        min={resolvedMin}
        max={resolvedMax}
        step={resolvedStep}
        value={value}
        onChange={(event) => {
          onValueChange?.(Number(event.target.value));
          props.onChange?.(event);
        }}
        {...props}
      />
    </div>
  );
}
