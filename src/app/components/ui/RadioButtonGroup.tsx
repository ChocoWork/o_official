import { cn } from '@/lib/utils';

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioButtonGroupProps {
  name: string;
  value: string;
  options: RadioOption[];
  onChange: (value: string) => void;
  direction?: 'row' | 'column';
  variant?: 'boxed' | 'simple';
}

export function RadioButtonGroup({
  name,
  value,
  options,
  onChange,
  direction = 'row',
  variant = 'boxed',
}: RadioButtonGroupProps) {
  return (
    <div className={cn('gap-4', direction === 'row' ? 'flex flex-wrap' : 'space-y-3')}>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex items-center gap-2',
            option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer group',
            variant === 'boxed' ? 'border border-black/20 px-3 py-2 hover:border-black' : 'px-0 py-0',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            disabled={option.disabled}
            className={cn('h-4 w-4', option.disabled ? 'cursor-not-allowed' : 'cursor-pointer accent-black')}
          />
          <span className={cn('text-sm text-black transition-colors', !option.disabled && variant === 'simple' ? 'group-hover:text-[#474747]' : null)}>{option.label}</span>
          {option.description ? <span className="text-xs text-[#474747]">{option.description}</span> : null}
        </label>
      ))}
    </div>
  );
}
