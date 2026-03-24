import { cn } from '@/lib/utils';
import { ComponentSize } from './types';

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
  size?: ComponentSize; // sm/md/lg for demo purposes
  label?: string;
  className?: string;
}

export function RadioButtonGroup({
  name,
  value,
  options,
  onChange,
  direction = 'column',
  variant = 'simple',
  size = 'md',
  label,
  className,
}: RadioButtonGroupProps) {
  // size-adjusted classes via explicit maps
  // md values correspond exactly to pre-refactor baseline
  // sm/lg chosen by stepping one unit smaller/larger
  const radioSizeClassMap: Record<ComponentSize, string> = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5', // baseline (originally hardcoded in the old impl)
    lg: 'h-6 w-6',
  };
  // typography sizes: md is original, sm/lg one step smaller/larger
  const labelTextSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm', // baseline
    lg: 'text-base',
  };
  // spacing between radio and label: md = gap-3 from baseline
  const itemGapMap: Record<ComponentSize, string> = {
    sm: 'gap-2',
    md: 'gap-3', // baseline
    lg: 'gap-4',
  };
  // padding inside boxed variant: baseline = px-3 py-2
  const boxedPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-2 py-1',
    md: 'px-3 py-2', // baseline
    lg: 'px-4 py-3',
  };
  // outer container gap between items; md matches previous gap-4
  const containerSpacingMap: Record<ComponentSize, string> = {
    sm: 'gap-3',
    md: 'gap-4', // baseline
    lg: 'gap-5',
  };
  const radioSizeClass = radioSizeClassMap[size];
  const labelTextSize = labelTextSizeMap[size];
  const itemGap = itemGapMap[size];
  const boxedPadding = boxedPaddingMap[size];
  const containerSpacing = containerSpacingMap[size];

  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <div className={cn(containerSpacing, direction === 'row' ? 'flex flex-wrap' : 'space-y-4', className)}>
        {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex items-center',
            itemGap,
            option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer group',
            variant === 'boxed' ? `border border-black/20 ${boxedPadding} hover:border-black` : 'px-0 py-0',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            disabled={option.disabled}
            className={cn(radioSizeClass, option.disabled ? 'cursor-not-allowed' : 'cursor-pointer accent-black')}
          />
          <span
            className={cn(
              labelTextSize,
              'text-black transition-colors',
              !option.disabled && variant === 'simple' ? 'group-hover:text-[#474747]' : null,
            )}
          >
            {option.label}
          </span>
          {option.description ? <span className="text-xs text-[#474747]">{option.description}</span> : null}
        </label>
      ))}
      </div>
    </label>
  );
}
