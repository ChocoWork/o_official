// File: src/components/ui/Dialog/Dialog.tsx
import '@/components/ui/Dialog/Dialog.css';
import { Button } from '@/components/ui/Button/Button';
import { cn } from '@/lib/utils';
import type { DialogProps } from '@/components/ui/Dialog/Dialog_types';

export function Dialog({
  open,
  onClose,
  title = 'Dialog Title',
  description,
  cancelText = 'CANCEL',
  confirmText = 'CONFIRM',
  onConfirm,
  children,
  className,
  shape = 'rounded',
  size = 'md',
}: DialogProps) {
  if (!open) {
    return null;
  }

  const rootDataAttrs = {
    'data-ui-dialog': 'true',
    'data-ui-dialog-shape': shape,
    'data-ui-dialog-size': size,
  } as const;

  return (
    <div
      className="dialog-overlay"
      onClick={onClose}
      role="presentation"
      {...rootDataAttrs}
    >
      <div className="dialog-overlay__scrim" aria-hidden="true" />
      <div
        className={cn('dialog-panel', className)}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="dialog-panel__body">
          <h3 className="dialog-panel__title">{title}</h3>
          {description ? (
            <p className="dialog-panel__description">{description}</p>
          ) : null}
          {children ? (
            <div className="dialog-panel__content">{children}</div>
          ) : (
            <div className="dialog-panel__actions">
              <Button
                type="button"
                variant="secondary"
                size={size}
                className="dialog-panel__action"
                onClick={onClose}
              >
                {cancelText}
              </Button>
              <Button
                type="button"
                size={size}
                className="dialog-panel__action"
                onClick={() => {
                  onConfirm?.();
                  onClose();
                }}
              >
                {confirmText}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}