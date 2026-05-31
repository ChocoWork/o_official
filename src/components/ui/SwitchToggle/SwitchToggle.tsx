import "./SwitchToggle.css"
import { cn } from '@/lib/utils';
import { ComponentSize } from '@/components/ui/types';

export interface SwitchToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  size?: ComponentSize;
}

// mappings for track/knob dimensions and label text size
const trackClass: Record<ComponentSize, string> = {
  xs: 'h-4 w-8',
  sm: 'h-4 w-8',
  md: 'h-6 w-12',
  lg: 'h-8 w-16',
  xl: 'h-8 w-16',
};
const thumbClass: Record<ComponentSize, string> = {
  xs: 'h-3 w-3',
  sm: 'h-3 w-3',
  md: 'h-4 w-4',
  lg: 'h-6 w-6',
  xl: 'h-6 w-6',
};
// moved slightly less than full width to leave right-side padding
const translateClass: Record<ComponentSize, string> = {
  xs: 'translate-x-4',
  sm: 'translate-x-4',
  md: 'translate-x-6',
  lg: 'translate-x-8',
  xl: 'translate-x-8',
};
const labelTextClass: Record<ComponentSize, string> = {
  xs: 'text-xs',
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
  xl: 'text-base',
};
// additional adjustments for tiny switch
const gapClass: Record<ComponentSize, string> = {
  xs: 'gap-2',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-3',
  xl: 'gap-3',
};
const topOffsetClass: Record<ComponentSize, string> = {
  xs: 'top-0.5',
  sm: 'top-0.5',
  md: 'top-1',
  lg: 'top-1',
  xl: 'top-1',
};
const leftOffsetClass: Record<ComponentSize, string> = {
  xs: 'left-0.5',
  sm: 'left-0.5',
  md: 'left-1',
  lg: 'left-1',
  xl: 'left-1',
};

export function SwitchToggle({
  checked,
  onChange,
  label,
  disabled = false,
  fullWidth = false,
  size = 'md',
}: SwitchToggleProps) {
  const track = trackClass[size];
  const thumb = thumbClass[size];
  const translate = translateClass[size];
  const labelClass = labelTextClass[size];
  const gap = gapClass[size];
  const topOffset = topOffsetClass[size];
  const leftOffset = leftOffsetClass[size];

  return (
    <label
      className={cn(
        'inline-flex items-center',
        gap,
        fullWidth ? 'w-full justify-between' : null,
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
      )}
    >
      {label ? <span className={cn(labelClass, 'text-black')}>{label}</span> : null}
      <button
        type="button"
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={cn('relative rounded-full transition-colors', track, checked ? 'bg-black' : 'bg-black/20')}
      >
        <span
          className={cn(
            'absolute rounded-full bg-white transition-transform',
            thumb,
            topOffset,
            leftOffset, // base position on the left
            checked && translate // shift to right when checked
          )}
        ></span>
      </button>
    </label>
  );
}
