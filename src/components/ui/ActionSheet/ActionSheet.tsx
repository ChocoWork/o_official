import '@/components/ui/ActionSheet/ActionSheet.css';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { ActionSheetProps } from '@/components/ui/ActionSheet/ActionSheet_types';

export function ActionSheet({
  open,
  onClose,
  actions,
  size = 'md',
  shape = 'rounded',
  cancelLabel = 'キャンセル',
  className,
}: ActionSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const rootDataAttrs = {
    'data-ui-action-sheet': 'true',
    'data-ui-action-sheet-size': size,
    'data-ui-action-sheet-shape': shape,
  } as const;

  return (
    <div
      className="action-sheet__overlay"
      role="presentation"
      onClick={onClose}
      {...rootDataAttrs}
    >
      <div className="action-sheet__backdrop" aria-hidden="true" />
      <div
        ref={panelRef}
        className={cn('action-sheet__panel', className)}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="action-sheet__list" role="group">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className="action-sheet__item"
              data-ui-action-sheet-destructive={action.destructive ? 'true' : undefined}
              onClick={() => {
                action.onSelect();
                onClose();
              }}
            >
              <span className="action-sheet__item-inner">
                {action.iconClass ? (
                  <span className="action-sheet__icon-box" aria-hidden="true">
                    <i className={cn(action.iconClass, 'action-sheet__icon')} />
                  </span>
                ) : null}
                <span className="action-sheet__label">{action.label}</span>
              </span>
            </button>
          ))}
        </div>

        <hr className="action-sheet__divider" />

        <div className="action-sheet__list">
          <button
            type="button"
            className="action-sheet__item action-sheet__item--cancel"
            onClick={onClose}
          >
            <span className="action-sheet__item-inner">
              <span className="action-sheet__label">{cancelLabel}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
