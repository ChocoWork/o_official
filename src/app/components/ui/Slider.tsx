import { cn } from '@/lib/utils';
import type { InputHTMLAttributes } from 'react';
import { ComponentSize } from './types';

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
  if (mode === 'range' && rangeValue && onRangeChange) {
    const rangeMin = Math.min(rangeValue[0], rangeValue[1]);
    const rangeMax = Math.max(rangeValue[0], rangeValue[1]);

    return (
      <div className="space-y-4">
        {(label || valueDisplay) ? (
          <div className="flex items-center justify-between">
            {label ? <span className="text-xs tracking-widest text-black/80 font-brand">{label}</span> : <span></span>}
            {valueDisplay ? <span className="text-sm text-black">{valueDisplay}</span> : null}
          </div>
        ) : null}
        <div className={`relative ${sliderHeight}`} data-testid="price-range-track-wrap">
          <div
            className="absolute left-0 top-1/2 h-1 w-full -translate-y-1/2 overflow-hidden rounded-full bg-black/20"
            data-testid="price-range-track"
          >
            <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
              <rect
                data-testid="price-range-fill"
                x={rangeMin}
                y={0}
                width={Math.max(rangeMax - rangeMin, 0)}
                height={1}
                fill="currentColor"
                className="text-black"
              />
            </svg>
          </div>
          <input
            min={min}
            max={max}
            className="pointer-events-none absolute left-0 top-1/2 z-20 h-4 w-full -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer"
            type="range"
            step={step}
            value={rangeMin}
            aria-label="Minimum value"
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onRangeChange([
                Math.min(nextValue, Math.max(rangeValue[0], rangeValue[1])),
                Math.max(rangeValue[0], rangeValue[1]),
              ]);
            }}
          />
          <input
            min={min}
            max={max}
            className="pointer-events-none absolute left-0 top-1/2 z-30 h-4 w-full -translate-y-1/2 appearance-none bg-transparent [accent-color:transparent] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-track]:h-1 [&::-moz-range-track]:bg-transparent [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer"
            type="range"
            step={step}
            value={rangeMax}
            aria-label="Maximum value"
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onRangeChange([
                Math.min(rangeValue[0], rangeValue[1]),
                Math.max(nextValue, Math.min(rangeValue[0], rangeValue[1])),
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
          {label ? <span className="text-xs tracking-widest text-black/80 font-brand">{label}</span> : <span></span>}
          {valueDisplay ? <span className="text-sm text-black">{valueDisplay}</span> : null}
        </div>
      ) : null}
      <input
        type="range"
        className={cn(
          'h-1 w-full cursor-pointer appearance-none rounded-full bg-black/20 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer',
          className,
        )}
        min={min}
        max={max}
        step={step}
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
