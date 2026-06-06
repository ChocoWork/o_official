// File: src/components/ui/Dialog/Dialog_types.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIDialogShape = 'rounded' | 'square';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  cancelText?: string;
  confirmText?: string;
  onConfirm?: () => void;
  children?: ReactNode;
  className?: string;
  /** corner shape: rounded (default) / square */
  shape?: UIDialogShape;
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
}