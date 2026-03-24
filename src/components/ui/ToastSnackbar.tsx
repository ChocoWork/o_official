import { cn } from '@/lib/utils';

export type ToastVariant = 'success' | 'error' | 'info';

import { ComponentSize } from './types';

export interface ToastSnackbarProps {
  open?: boolean;
  message: string;
  variant?: ToastVariant;
  showIcon?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  size?: ComponentSize;
}

export function ToastSnackbar({
  open = true,
  message,
  variant = 'success',
  showIcon = true,
  actionLabel,
  onAction,
  className,
  size = 'md',
}: ToastSnackbarProps) {
  if (!open) {
    return null;
  }

  const iconClass =
    variant === 'error'
      ? 'ri-error-warning-line'
      : variant === 'info'
      ? 'ri-information-line'
      : 'ri-check-line';

  const frameMap: Record<ComponentSize, string> = {
    sm: 'h-8 px-3',
    md: 'h-10 px-4',
    lg: 'h-12 px-5',
  };
  const textMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-sm',
  };
  const iconSizeMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };
  const gapMap: Record<ComponentSize, string> = {
    sm: 'gap-2',
    md: 'gap-2',
    lg: 'gap-3',
  };

  const frame = frameMap[size];
  const textSize = textMap[size];
  const iconSize = iconSizeMap[size];
  const gap = gapMap[size];

  return (
    <div
      className={cn(
        'w-fit max-w-full bg-black text-white shadow-2xl animate-[slideIn_0.3s_ease-out] flex items-center',
        frame,
        className,
      )}
    >
      <div className={cn('flex items-center', gap)}>
        {showIcon ? (
          <div className="flex items-center justify-center">
            <i className={cn(iconClass, iconSize)}></i>
          </div>
        ) : null}
        <span className={cn('tracking-widest', textSize)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          {message}
        </span>
        {actionLabel && onAction ? (
          <button type="button" onClick={onAction} className={cn('tracking-widest underline underline-offset-2', textSize)}>
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
