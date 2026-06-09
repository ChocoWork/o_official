import type { ReactNode } from 'react';

export interface BaseOverlayProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}
