import type { ReactNode } from 'react';

export type SheetSize = 'md' | 'lg';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** md = 50vh（デフォルト）, lg = 90vh */
  size?: SheetSize;
  className?: string;
}
