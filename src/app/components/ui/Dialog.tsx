import { Button } from './Button';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

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
}

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
}: DialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40"></div>
      <div
        className={cn('relative mx-4 w-full max-w-md bg-white shadow-2xl', className)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-8">
          <h3 className="mb-4 text-2xl tracking-tight text-black font-title">{title}</h3>
          {description ? <p className="mb-8 text-sm leading-relaxed text-black/60 font-brand">{description}</p> : null}
          {children ? (
            children
          ) : (
            <div className="flex items-center gap-4">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={onClose}
              >
                {cancelText}
              </Button>
              <Button
                type="button"
                className="flex-1"
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
