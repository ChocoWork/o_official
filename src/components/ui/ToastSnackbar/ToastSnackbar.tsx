// File: src/components/ui/ToastSnackbar/ToastSnackbar.tsx
import '@/components/ui/ToastSnackbar/ToastSnackbar.css';
import { cn } from '@/lib/utils';
import type {
  ToastSnackbarProps,
  UIToastSnackbarVariant,
} from '@/components/ui/ToastSnackbar/ToastSnackbar_type';

const VARIANT_ICON_CLASS: Record<UIToastSnackbarVariant, string> = {
  success: 'ri-check-line',
  error: 'ri-error-warning-line',
  info: 'ri-information-line',
};

export function ToastSnackbar({
  open = true,
  message,
  variant = 'success',
  shape = 'rounded',
  showIcon = true,
  icon,
  actionLabel,
  onAction,
  className,
  size = 'md',
}: ToastSnackbarProps) {
  if (!open) {
    return null;
  }

  const rootDataAttrs = {
    'data-ui-toast-snackbar': 'true',
    'data-ui-toast-snackbar-variant': variant,
    'data-ui-toast-snackbar-shape': shape,
    'data-ui-toast-snackbar-size': size,
  } as const;

  const iconNode = icon ?? (
    <i className={VARIANT_ICON_CLASS[variant]} aria-hidden="true" />
  );

  return (
    <div
      className={cn('toast-snackbar', className)}
      {...rootDataAttrs}
      role="status"
      aria-live="polite"
    >
      <div className="toast-snackbar__body">
        {showIcon ? (
          <span className="toast-snackbar__icon" aria-hidden="true">
            {iconNode}
          </span>
        ) : null}
        <span className="toast-snackbar__message">{message}</span>
        {actionLabel && onAction ? (
          <button
            type="button"
            className="toast-snackbar__action"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}