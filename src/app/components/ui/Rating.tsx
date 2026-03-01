import { cn } from '@/lib/utils';

export interface RatingProps {
  value: number;
  max?: number;
  onChange?: (value: number) => void;
  label?: string;
  readOnly?: boolean;
  showValue?: boolean;
  valueText?: string;
  className?: string;
}

export function Rating({
  value,
  max = 5,
  onChange,
  label,
  readOnly = false,
  showValue = false,
  valueText,
  className,
}: RatingProps) {
  const interactive = Boolean(onChange) && !readOnly;

  return (
    <div className={cn('space-y-3', className)}>
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <div className="flex items-center gap-2">
        {Array.from({ length: max }).map((_, index) => {
          const score = index + 1;
          const filled = score <= value;

          if (interactive) {
            return (
              <button
                key={score}
                type="button"
                className="cursor-pointer"
                onClick={() => onChange?.(score)}
                aria-label={`rating-${score}`}
              >
                <span className="flex h-6 w-6 items-center justify-center">
                  <i className={cn('text-2xl text-black', filled ? 'ri-star-fill' : 'ri-star-line')}></i>
                </span>
              </button>
            );
          }

          return (
            <span key={score} className="flex h-6 w-6 items-center justify-center" aria-hidden="true">
              <i className={cn('text-2xl text-black', filled ? 'ri-star-fill' : 'ri-star-line')}></i>
            </span>
          );
        })}
        {showValue ? <span className="ml-3 text-sm text-black">{valueText ?? `${value} / ${max}`}</span> : null}
      </div>
    </div>
  );
}
