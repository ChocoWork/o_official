import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type StatusBadgeTone = 'neutral' | 'positive' | 'warning' | 'danger';
export type StatusBadgeVariant = 'text' | 'count' | 'dot';

export interface StatusBadgeProps {
  children?: ReactNode;
  tone?: StatusBadgeTone;
  variant?: StatusBadgeVariant;
  count?: number | string;
  className?: string;
  size?: ComponentSize;
}
