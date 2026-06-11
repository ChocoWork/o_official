// File: src/components/ui/ColorPicker/ColorPicker.tsx
import '@/components/ui/ColorPicker/ColorPicker.css';
import { cn } from '@/lib/utils';
import type { ChangeEventHandler } from 'react';
import type {
  ColorPickerProps,
} from '@/components/ui/ColorPicker/ColorPicker_types';

const HEX6_PATTERN = /^#[0-9A-Fa-f]{6}$/;

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
  const handleColorInputChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  const rootDataAttrs = {
    'data-ui-color-picker': 'true',
    'data-ui-color-picker-variant': variant,
    'data-ui-color-picker-size': size,
    'data-ui-size': size,
  } as const;

  // --- preset：スウォッチを横並びで選択 ---
  if (variant === 'preset') {
    return (
      <div className={cn('color-picker', className)} {...rootDataAttrs}>
        {label ? <span className="color-picker__label">{label}</span> : null}
        <div className="color-picker__swatch-row">
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={cn('color-picker__swatch', preset.swatchClass)}
              data-ui-color-picker-selected={
                preset.value === value ? 'true' : undefined
              }
              style={
                preset.swatchClass
                  ? undefined
                  : { backgroundColor: preset.value }
              }
              title={preset.value}
              onClick={() => onValueChange?.(preset.value)}
              aria-label={preset.value}
              aria-pressed={preset.value === value}
            />
          ))}
        </div>
      </div>
    );
  }

  // --- custom：カラーボックス＋HEX テキスト入力 ---
  if (variant === 'custom') {
    return (
      <div className={cn('color-picker', className)} {...rootDataAttrs}>
        {label ? <span className="color-picker__label">{label}</span> : null}
        <div className="color-picker__custom-row">
          <input
            type="color"
            value={value}
            onChange={handleColorInputChange}
            className="color-picker__color-box"
            aria-label={label ?? 'カラーを選択'}
            {...props}
          />
          <input
            type="text"
            value={value}
            className="color-picker__hex-input"
            onChange={(event) => {
              const nextValue = event.target.value;
              if (HEX6_PATTERN.test(nextValue)) {
                onValueChange?.(nextValue);
              }
            }}
            aria-label="HEX 値"
            spellCheck={false}
          />
        </div>
      </div>
    );
  }

  // --- input（既定）：円形スウォッチ単体 ---
  return (
    <label className={cn('color-picker', 'color-picker__circle', className)} {...rootDataAttrs}>
      {label ? <span className="color-picker__sr-only">{label}</span> : null}
      <input
        type="color"
        value={value}
        onChange={handleColorInputChange}
        className="color-picker__native"
        aria-label={label ?? 'カラーを選択'}
        {...props}
      />
      <span
        className="color-picker__circle-face"
        style={{ backgroundColor: value }}
        aria-hidden="true"
      />
    </label>
  );
}