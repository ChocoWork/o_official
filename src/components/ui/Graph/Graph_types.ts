import type { ComponentSize } from '@/components/ui/types';

export type GraphVariant = 'progress' | 'bars' | 'donut';

export interface GraphDatum {
  label: string;
  value: number;
  color?: string;
}

export interface GraphProps {
  data: readonly GraphDatum[];
  maxValue?: number;
  variant?: GraphVariant;
  className?: string;
  legendClassName?: string;
  size?: ComponentSize | number;
}
