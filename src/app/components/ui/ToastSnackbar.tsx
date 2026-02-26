export interface ToastSnackbarProps {
  open: boolean;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function ToastSnackbar({ open, message, actionLabel, onAction }: ToastSnackbarProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 border border-black/10 bg-black px-4 py-3 text-sm text-white shadow-sm">
      <div className="flex items-center gap-4">
        <span>{message}</span>
        {actionLabel && onAction ? (
          <button type="button" onClick={onAction} className="text-xs tracking-wider underline underline-offset-2">
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
