import "./Rating.css";
import type { RatingProps } from "./Rating_type";

export type { RatingProps } from "./Rating_type";

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

  return (
    <div
      data-ui-rating=""
      data-ui-size={size}
      className={className}
    >
      {label && <span data-ui-rating-label="">{label}</span>}
      <div data-ui-rating-stars="">
        {Array.from({ length: max }).map((_, index) => {
          const score = index + 1;
          const filled = score <= value;
          const iconClass = filled ? 'ri-star-fill' : 'ri-star-line';

          if (interactive) {
            return (
              <button
                key={score}
                type="button"
                data-ui-rating-star=""
                data-testid="rating-star"
                onClick={() => onChange?.(score)}
                aria-label={`rating-${score}`}
              >
                <i className={iconClass} aria-hidden="true" />
              </button>
            );
          }

          return (
            <span
              key={score}
              data-ui-rating-star=""
              data-testid="rating-star"
              aria-hidden="true"
            >
              <i className={iconClass} />
            </span>
          );
        })}
        {showValue && (
          <span data-ui-rating-value="">
            {valueText ?? `${value} / ${max}`}
          </span>
        )}
      </div>
    </div>
  );
}
