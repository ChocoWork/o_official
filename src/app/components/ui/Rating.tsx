import { cn } from '@/lib/utils';

export interface RatingProps {
  value: number;
  max?: number;
  onChange?: (value: number) => void;
}

export function Rating({ value, max = 5, onChange }: RatingProps) {
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: max }).map((_, index) => {
        const score = index + 1;
        return (
          <button
            key={score}
            type="button"
            className={cn('text-lg transition-transform', score <= value ? 'text-black' : 'text-black/20', onChange ? 'cursor-pointer hover:scale-110' : 'cursor-default')}
            onClick={() => onChange?.(score)}
            aria-label={`rating-${score}`}
            disabled={!onChange}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
