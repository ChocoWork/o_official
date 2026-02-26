import { cn } from '@/lib/utils';

export interface SwitchToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function SwitchToggle({ checked, onChange, label, disabled = false }: SwitchToggleProps) {
  return (
    <label className={cn('inline-flex items-center gap-3', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={cn(
          'relative h-6 w-11 rounded-full border transition-colors',
          checked ? 'border-black bg-black' : 'border-black/30 bg-white',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5 bg-black/70',
          )}
        />
      </button>
      {label ? <span className="text-sm text-black">{label}</span> : null}
    </label>
  );
}
