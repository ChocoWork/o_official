import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface FloatingButtonAction {
  key: string;
  iconClass: string;
  onClick: () => void;
}

export interface FloatingButtonProps {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  actions?: FloatingButtonAction[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  fixed?: boolean;
  className?: string;
}

export function FloatingButton({
  icon,
  label,
  onClick,
  actions,
  open = false,
  onOpenChange,
  fixed = true,
  className,
}: FloatingButtonProps) {
  const hasActions = Boolean(actions && actions.length > 0);

  return (
    <div className={cn('relative', fixed ? 'fixed bottom-6 right-6 z-40' : null, className)}>
      {hasActions && open ? (
        <div className="absolute bottom-16 right-0 mb-3 space-y-3">
          {actions?.map((action) => (
            <button
              key={action.key}
              type="button"
              className="flex h-12 w-12 cursor-pointer items-center justify-center border border-black/20 bg-white shadow-lg transition-all hover:bg-[#f5f5f5]"
              onClick={action.onClick}
            >
              <div className="flex h-5 w-5 items-center justify-center">
                <i className={cn(action.iconClass, 'text-xl')}></i>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => {
          if (hasActions) {
            onOpenChange?.(!open);
            return;
          }
          onClick();
        }}
        className={cn(
          hasActions
            ? 'flex h-14 w-14 cursor-pointer items-center justify-center bg-black text-white shadow-2xl transition-all hover:bg-[#474747]'
            : 'inline-flex h-14 min-w-14 items-center justify-center gap-2 rounded-full bg-black px-5 text-white shadow-sm transition-colors hover:bg-[#474747]',
        )}
      >
        {hasActions ? (
          <div className="flex h-6 w-6 items-center justify-center">
            <i className={cn(open ? 'ri-close-line' : 'ri-add-line', 'text-2xl transition-transform')}></i>
          </div>
        ) : (
          <>
            {icon}
            <span className="text-xs tracking-wider">{label}</span>
          </>
        )}
      </button>
    </div>
  );
}
