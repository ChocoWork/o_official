// File: src/components/ui/FloatingButton/FloatingButton.tsx
import '@/components/ui/FloatingButton/FloatingButton.css';
import { cn } from '@/lib/utils';
import type { FloatingButtonProps } from '@/components/ui/FloatingButton/FloatingButton_type';

export function FloatingButton({
  icon,
  label,
  onClick,
  actions,
  open = false,
  onOpenChange,
  fixed = true,
  className,
  size = 'md',
}: FloatingButtonProps) {
  const hasActions = Boolean(actions && actions.length > 0);

  const rootDataAttrs = {
    'data-ui-floating-button': 'true',
    'data-ui-floating-button-size': size,
    'data-ui-floating-button-mode': hasActions ? 'speed-dial' : 'single',
    'data-ui-floating-button-fixed': fixed ? 'true' : undefined,
    'data-ui-floating-button-open': open ? 'true' : undefined,
  } as const;

  const handleMainClick = () => {
    if (hasActions) {
      onOpenChange?.(!open);
      return;
    }
    onClick();
  };

  return (
    <div className={cn('floating-button-shell', className)} {...rootDataAttrs}>
      <div className="floating-button">
        {hasActions && open ? (
          <div className="floating-button__actions" role="menu">
            {actions?.map((action) => (
              <button
                key={action.key}
                type="button"
                className="floating-button__action"
                role="menuitem"
                onClick={action.onClick}
              >
                <span className="floating-button__action-icon" aria-hidden="true">
                  <i className={action.iconClass} />
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          className="floating-button__main"
          aria-haspopup={hasActions ? 'menu' : undefined}
          aria-expanded={hasActions ? open : undefined}
          aria-label={hasActions ? label : undefined}
          onClick={handleMainClick}
        >
          {hasActions ? (
            <span className="floating-button__main-icon" aria-hidden="true">
              <i className={open ? 'ri-close-line' : 'ri-add-line'} />
            </span>
          ) : (
            <>
              {icon ? (
                <span className="floating-button__main-icon" aria-hidden="true">
                  {icon}
                </span>
              ) : null}
              <span className="floating-button__main-label">{label}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}