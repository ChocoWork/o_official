import type { ComponentSize } from '@/components/ui/types';

export type UIStepperVariant = 'compact' | 'field';

export interface StepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  variant?: UIStepperVariant;
  className?: string;
  size?: ComponentSize;
}