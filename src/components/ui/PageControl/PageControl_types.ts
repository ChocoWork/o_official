import type { ComponentSize } from '@/components/ui/types';

export interface PageControlProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
  size?: ComponentSize;
}
