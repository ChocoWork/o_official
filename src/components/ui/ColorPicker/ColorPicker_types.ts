// File: src/components/ui/ColorPicker/ColorPicker_types.ts
import type { ChangeEventHandler, InputHTMLAttributes } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface ColorPreset {
  value: string;
  /** 任意のスウォッチ装飾クラス（グラデーション等）。未指定時は value を背景色に使用 */
  swatchClass?: string;
}

export type UIColorPickerVariant = 'input' | 'preset' | 'custom';

export interface ColorPickerProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'onChange' | 'size'
  > {
  label?: string;
  variant?: UIColorPickerVariant;
  presets?: ReadonlyArray<ColorPreset>;
  value?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  onValueChange?: (value: string) => void;
  /** demo-friendly size: xs/sm/md/lg/xl default md */
  size?: ComponentSize;
}