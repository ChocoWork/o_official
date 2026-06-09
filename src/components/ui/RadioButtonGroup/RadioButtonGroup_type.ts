import type { ComponentSize } from '@/components/ui/types';

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export type RadioButtonGroupVariant = 'boxed' | 'simple';
export type RadioButtonGroupDirection = 'row' | 'column';

export interface RadioButtonGroupProps {
  name: string;
  value: string;
  options: RadioOption[];
  onChange: (value: string) => void;
  direction?: RadioButtonGroupDirection;
  variant?: RadioButtonGroupVariant;
  size?: ComponentSize;
  label?: string;
  className?: string;
}
