import type { InputHTMLAttributes } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type SliderMode = 'single' | 'range';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  mode?: SliderMode;
  value?: number;
  onValueChange?: (value: number) => void;
  rangeValue?: [number, number];
  onRangeChange?: (value: [number, number]) => void;
  valueDisplay?: string;
  size?: ComponentSize;
}
