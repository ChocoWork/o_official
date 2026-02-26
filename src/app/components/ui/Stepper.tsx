import { Button } from './Button';

export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}

export function Stepper({ value, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1, onChange }: StepperProps) {
  const next = Math.min(max, value + step);
  const prev = Math.max(min, value - step);

  return (
    <div className="inline-flex items-center border border-black/20">
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
