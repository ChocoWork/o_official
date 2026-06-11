import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface BaseOverlayProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  size?: ComponentSize;
}
