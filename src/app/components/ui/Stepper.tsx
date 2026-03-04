import { Button } from './Button';
import { cn } from '@/lib/utils';

export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  variant?: 'compact' | 'field';
  className?: string;
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
}: StepperProps) {
  const clamp = (nextValue: number) => Math.min(max, Math.max(min, nextValue));
  const next = clamp(value + step);
  const prev = clamp(value - step);

  if (variant === 'field') {
    return (
      <div className={cn('space-y-2', className)}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
        <div className="flex items-center border border-black/20">
          <button
            type="button"
            className="flex h-12 w-12 cursor-pointer items-center justify-center transition-colors hover:bg-[#f5f5f5]"
            onClick={() => onChange(prev)}
            aria-label="decrease"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <i className="ri-subtract-line text-base"></i>
            </span>
          </button>
          <input
            className="h-12 flex-1 text-center text-sm focus:outline-none"
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
            className="flex h-12 w-12 cursor-pointer items-center justify-center transition-colors hover:bg-[#f5f5f5]"
            onClick={() => onChange(next)}
            aria-label="increase"
          >
            <span className="flex h-4 w-4 items-center justify-center">
              <i className="ri-add-line text-base"></i>
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('inline-flex items-center border border-black/20', className)}>
      <Button size="sm" variant="ghost" onClick={() => onChange(prev)} aria-label="decrease">
        −
      </Button>
      <span className="min-w-12 px-3 text-center text-sm">{value}</span>
      <Button size="sm" variant="ghost" onClick={() => onChange(next)} aria-label="increase">
        ＋
      </Button>
    </div>
  );
}
