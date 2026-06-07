// File: src/components/ui/ToastSnackbar/ToastSnackbar_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIToastSnackbarVariant = 'success' | 'error' | 'info';

export type UIToastSnackbarShape = 'rounded' | 'square';

export interface ToastSnackbarProps {
  /** 表示制御。false の場合は何も描画しない */
  open?: boolean;
  message: string;
  variant?: UIToastSnackbarVariant;
  /** corner shape: rounded (default) / square */
  shape?: UIToastSnackbarShape;
  showIcon?: boolean;
  /** アイコンを差し替えたい場合に指定（未指定なら variant 既定アイコン） */
  icon?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
}