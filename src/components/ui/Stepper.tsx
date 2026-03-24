import { Button } from './Button';
import { cn } from '@/lib/utils';
import { ComponentSize } from './types';

import type { UIButtonSize } from './Button';

export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  variant?: 'compact' | 'field';
  className?: string;
  size?: ComponentSize;
}

export function Stepper({
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  onChange,
  label,
  variant = 'compact',
  className,
  size = 'md',
}: StepperProps) {
  const clamp = (nextValue: number) => Math.min(max, Math.max(min, nextValue));
  const next = clamp(value + step);
  const prev = clamp(value - step);

  // size-dependent classes via explicit maps for clarity
  // height should match Button height for each size
  const heightClassMap: Record<ComponentSize, string> = {
    sm: 'h-8', // matches Button.sm
    md: 'h-10', // matches Button.md
    lg: 'h-12', // matches Button.lg
  };
  const textClassMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };
  // make side button width equal height to form square buttons
  const sideButtonWidthMap: Record<ComponentSize, string> = {
    sm: 'w-8',
    md: 'w-10',
    lg: 'w-12',
  };
  const iconBoxClassMap: Record<ComponentSize, string> = {
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
    lg: 'h-6 w-6',
  };
  const iconClassMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };
  const compactButtonSizeMap: Record<ComponentSize, UIButtonSize> = {
    sm: 'sm',
    md: 'sm',
    lg: 'md',
  };
  // compact variant input width scaled relative to height
  const compactInputWidthMap: Record<ComponentSize, string> = {
    sm: 'w-8',
    md: 'w-10',
    lg: 'w-12',
  };
  const heightClass = heightClassMap[size];
  const textClass = textClassMap[size];
  const sideButtonWidth = sideButtonWidthMap[size];
  const iconBoxClass = iconBoxClassMap[size];
  const iconClass = iconClassMap[size];
  const compactButtonSize = compactButtonSizeMap[size];
  const compactInputWidth = compactInputWidthMap[size];


  if (variant === 'field') {
    return (
      <div className={cn('space-y-2', className)}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
        <div className="flex items-center border border-black/20">
          <button
            type="button"
            className={cn('flex cursor-pointer items-center justify-center transition-colors hover:bg-[#f5f5f5]', heightClass, sideButtonWidth)}
            onClick={() => onChange(prev)}
            aria-label="decrease"
          >
            <span className={cn('flex items-center justify-center', iconBoxClass)}>
              <i className={cn('ri-subtract-line', iconClass)}></i>
            </span>
          </button>
          <input
            className={cn(heightClass, 'flex-1 text-center', textClass, 'focus:outline-none appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-moz-appearance]:textfield')}
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              if (!Number.isNaN(parsed)) {
                onChange(clamp(parsed));
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                onChange(next);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                onChange(prev);
              }
            }}
          />
          <button
            type="button"
            className={cn('flex cursor-pointer items-center justify-center transition-colors hover:bg-[#f5f5f5]', heightClass, sideButtonWidth)}
            onClick={() => onChange(next)}
            aria-label="increase"
          >
            <span className={cn('flex items-center justify-center', iconBoxClass)}>
              <i className={cn('ri-add-line', iconClass)}></i>
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('inline-flex items-center border border-black/20', className)}>
      <Button
        size={compactButtonSize}
        variant="ghost"
        onClick={() => onChange(prev)}
        aria-label="decrease"
      >
        −
      </Button>
      <input
        className={cn(compactInputWidth, 'text-center', textClass, 'focus:outline-none appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-moz-appearance]:textfield')}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (!Number.isNaN(parsed)) {
            onChange(clamp(parsed));
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            onChange(next);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            onChange(prev);
          }
        }}
      />
      <Button
        size={compactButtonSize}
        variant="ghost"
        onClick={() => onChange(next)}
        aria-label="increase"
      >
        ＋
      </Button>
    </div>
  );
}
