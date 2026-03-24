import { cn } from '@/lib/utils';
import type { ChangeEventHandler, InputHTMLAttributes } from 'react';
import { ComponentSize } from './types';

interface ColorPreset {
  value: string;
  swatchClass?: string;
}

export interface ColorPickerProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'size'> {
  label?: string;
  variant?: 'input' | 'preset' | 'custom';
  presets?: ReadonlyArray<ColorPreset>;
  value?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  onValueChange?: (value: string) => void;
  size?: ComponentSize;
}

export function ColorPicker({
  label,
  className,
  variant = 'input',
  presets = [],
  value = '#000000',
  onChange,
  onValueChange,
  size = 'md',
  ...props
}: ColorPickerProps) {
  const sizeClass = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-12 w-12' : 'h-10 w-10';
  const handleColorInputChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  if (variant === 'preset') {
    return (
      <div className={cn('space-y-3', className)}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
        <div className="flex items-center gap-3">
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={cn(
                sizeClass,
                'cursor-pointer rounded-full border-2 transition-all',
                preset.swatchClass,
                preset.value === value ? 'border-black' : 'border-black/20',
              )}
              style={preset.swatchClass ? undefined : { backgroundColor: preset.value }}
              title={preset.value}
              onClick={() => onValueChange?.(preset.value)}
            ></button>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'custom') {
    return (
      <div className={cn('space-y-3', className)}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
        <div className="flex items-center gap-4">
          <input
            type="color"
            value={value}
            onChange={handleColorInputChange}
            className="h-12 w-16 cursor-pointer border border-black/20"
            {...props}
          />
          <input
            type="text"
            value={value}
            className="flex-1 border border-black/20 px-4 py-3 text-sm uppercase transition-colors focus:border-black focus:outline-none"
            onChange={(event) => {
              const nextValue = event.target.value;
              if (/^#[0-9A-Fa-f]{6}$/.test(nextValue)) {
                onValueChange?.(nextValue);
              }
            }}
          />
        </div>
      </div>
    );
  }

  // for the default 'input' variant we now always render a circular swatch
  if (variant === 'input') {
    return (
      <label className={cn('relative inline-block', sizeClass)}>
        {label ? <span className="sr-only">{label}</span> : null}
        <input
          type="color"
          value={value}
          onChange={handleColorInputChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer rounded-full"
          {...props}
        />
        <span
          className={cn(
            'block h-full w-full rounded-full border border-black/20',
            // allow size overrides via className but ignore other styles
            className
          )}
          style={{ backgroundColor: value }}
        />
      </label>
    );
  }

  // fallback to rectangular input if someone requests custom variant
  return (
    <label className="inline-flex items-center gap-3">
      {label ? <span className="text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <input
        type="color"
        value={value}
        onChange={handleColorInputChange}
        className={cn('h-10 w-16 cursor-pointer border border-black/20', className)}
        {...props}
      />
    </label>
  );
}
