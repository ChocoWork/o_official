import { cn } from '@/lib/utils';

export interface SwitchToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  fullWidth?: boolean;
}

export function SwitchToggle({ checked, onChange, label, disabled = false, fullWidth = false }: SwitchToggleProps) {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-3',
        fullWidth ? 'w-full justify-between' : null,
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
      )}
    >
      {label ? <span className="text-sm text-black">{label}</span> : null}
      <button
        type="button"
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={cn('relative h-6 w-12 rounded-full transition-colors', checked ? 'bg-black' : 'bg-black/20')}
      >
        <span
          className={cn(
            'absolute top-1 h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-7' : 'left-1',
          )}
        ></span>
      </button>
    </label>
  );
}
