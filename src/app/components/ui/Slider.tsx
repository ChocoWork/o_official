import { cn } from '@/lib/utils';
import type { InputHTMLAttributes } from 'react';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export function Slider({ label, className, ...props }: SliderProps) {
  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-wider text-black/80 font-brand">{label}</span> : null}
      <input
        type="range"
        className={cn(
          'h-1 w-full cursor-pointer appearance-none rounded-full bg-black/20 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-black [&::-moz-range-thumb]:cursor-pointer',
          className,
        )}
        {...props}
      />
    </label>
  );
}
