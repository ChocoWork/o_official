import type { ComponentSize } from '@/components/ui/types';

export interface RatingProps {
  value: number;
  max?: number;
  onChange?: (value: number) => void;
  label?: string;
  readOnly?: boolean;
  showValue?: boolean;
  valueText?: string;
  className?: string;
  size?: ComponentSize;
}
