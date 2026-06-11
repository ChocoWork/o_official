// File: src/components/ui/Stepper/Stepper.tsx
import '@/components/ui/Stepper/Stepper.css';
import { cn } from '@/lib/utils';
import type { StepperProps } from '@/components/ui/Stepper/Stepper_types';

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

  const atMin = value <= min;
  const atMax = value >= max;

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = Number.parseInt(event.target.value, 10);
    if (!Number.isNaN(parsed)) {
      onChange(clamp(parsed));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      onChange(next);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      onChange(prev);
    }
  };

  const rootDataAttrs = {
    'data-ui-stepper': 'true',
    'data-ui-stepper-variant': variant,
    'data-ui-stepper-size': size,
    'data-ui-size': size,
  } as const;

  const decreaseButton = (
    <button
      type="button"
      data-ui-stepper-control="decrease"
      className="stepper__control"
      onClick={() => onChange(prev)}
      disabled={atMin}
      aria-label="decrease"
    >
      <span className="stepper__icon-box" aria-hidden="true">
        <i className="ri-subtract-line stepper__icon" />
      </span>
    </button>
  );

  const increaseButton = (
    <button
      type="button"
      data-ui-stepper-control="increase"
      className="stepper__control"
      onClick={() => onChange(next)}
      disabled={atMax}
      aria-label="increase"
    >
      <span className="stepper__icon-box" aria-hidden="true">
        <i className="ri-add-line stepper__icon" />
      </span>
    </button>
  );

  const input = (
    <input
      className="stepper__input"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={handleInputChange}
      onKeyDown={handleKeyDown}
      aria-label={label ?? 'value'}
    />
  );

  if (variant === 'field') {
    return (
      <div className={cn('stepper__wrapper', className)} {...rootDataAttrs}>
        {label ? <span className="stepper__label">{label}</span> : null}
        <div className="stepper__group">
          {decreaseButton}
          {input}
          {increaseButton}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('stepper__group', className)} {...rootDataAttrs}>
      {decreaseButton}
      {input}
      {increaseButton}
    </div>
  );
}