import { cn } from '@/lib/utils';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastSnackbarProps {
  open?: boolean;
  message: string;
  variant?: ToastVariant;
  showIcon?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function ToastSnackbar({
  open = true,
  message,
  variant = 'success',
  showIcon = true,
  actionLabel,
  onAction,
  className,
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

  return (
    <div
      className={cn(
        'min-w-[300px] bg-black px-6 py-4 text-white shadow-2xl animate-[slideIn_0.3s_ease-out]',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {showIcon ? (
          <div className="flex h-5 w-5 items-center justify-center">
            <i className={cn(iconClass, 'text-xl')}></i>
          </div>
        ) : null}
        <span className="text-sm" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          {message}
        </span>
        {actionLabel && onAction ? (
          <button type="button" onClick={onAction} className="text-xs tracking-wider underline underline-offset-2">
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
