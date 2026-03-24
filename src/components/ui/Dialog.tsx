import { Button } from './Button';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';
import type { UIButtonSize } from './Button';

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
  /** demo size (sm/md/lg) */
  size?: ComponentSize;
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
  size = 'md',
}: DialogProps) {
  if (!open) {
    return null;
  }

  const widthMap: Record<ComponentSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
  };
  const paddingMap: Record<ComponentSize, string> = {
    sm: 'p-4',
    md: 'p-8',
    lg: 'p-12',
  };
  const titleSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-3xl',
  };
  const descSizeMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-sm',
    lg: 'text-base',
  };

  const buttonSizeMap: Record<ComponentSize, UIButtonSize> = {
    sm: 'sm',
    md: 'md',
    lg: 'lg',
  };
  const buttonSize = buttonSizeMap[size];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40"></div>
      <div
        className={cn('relative mx-4 w-full bg-white shadow-2xl', widthMap[size], className)}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={cn(paddingMap[size])}>
          <h3 className={cn('mb-4 tracking-tight text-black font-title', titleSizeMap[size])}>{title}</h3>
          {description ? (
            <p className={cn('mb-8 leading-relaxed text-black/60 font-brand', descSizeMap[size])}>{description}</p>
          ) : null}
          {children ? (
            children
          ) : (
            <div className="flex items-center gap-4">
              <Button
                type="button"
                variant="secondary"
                size={buttonSize}
                className="flex-1"
                onClick={onClose}
              >
                {cancelText}
              </Button>
              <Button
                type="button"
                size={buttonSize}
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
