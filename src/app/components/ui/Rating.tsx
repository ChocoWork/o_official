import { cn } from '@/lib/utils';

import { ComponentSize } from './types';

export interface RatingProps {
  value: number;
  max?: number;
  onChange?: (value: number) => void;
  label?: string;
  readOnly?: boolean;
  showValue?: boolean;
  valueText?: string;
  className?: string;
  /**
   * Component size. Determines star dimensions and font-size of icons/text.
   * Defaults to 'md' to maintain previous behaviour.
   */
  size?: ComponentSize;
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
  size = 'md',
}: RatingProps) {
  const interactive = Boolean(onChange) && !readOnly;

  // compute sizing classes for star container and icon
  const starSizeClass =
    size === 'sm'
      ? 'h-4 w-4 text-xl'
      : size === 'lg'
      ? 'h-8 w-8 text-3xl'
      : 'h-6 w-6 text-2xl';

  // determine text size for optional value display
  const valueTextClass = size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-base' : 'text-sm';

  return (
    <div className={cn('space-y-3', className)}>
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <div className="flex items-center gap-2">
        {Array.from({ length: max }).map((_, index) => {
          const score = index + 1;
          const filled = score <= value;

          const star = (
            <span data-testid="rating-star" className={cn('flex items-center justify-center', starSizeClass)}>
              <i className={cn('text-black', filled ? 'ri-star-fill' : 'ri-star-line')}></i>
            </span>
          );

          if (interactive) {
            return (
              <button
                key={score}
                type="button"
                className="cursor-pointer"
                onClick={() => onChange?.(score)}
                aria-label={`rating-${score}`}
              >
                {star}
              </button>
            );
          }

          return (
            <span key={score} aria-hidden="true">
              {star}
            </span>
          );
        })}
        {showValue ? <span className={cn('ml-3 text-black', valueTextClass)}>{valueText ?? `${value} / ${max}`}</span> : null}
      </div>
    </div>
  );
}
