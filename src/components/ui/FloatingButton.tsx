import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';
import { Button } from './Button';
import type { UIButtonSize } from './Button';

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
  size?: ComponentSize;
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
  size = 'md',
}: FloatingButtonProps) {
  const hasActions = Boolean(actions && actions.length > 0);
  const buttonSizeMap: Record<ComponentSize, UIButtonSize> = {
    sm: 'sm',
    md: 'md',
    lg: 'lg',
  };
  const buttonSize = buttonSizeMap[size];
  const actionsOffsetClass = size === 'sm' ? 'bottom-12' : size === 'lg' ? 'bottom-20' : 'bottom-16';

  return (
    <div className={cn('relative', fixed ? 'fixed bottom-6 right-6 z-40' : null, className)}>
      {hasActions && open ? (
        <div className={cn('absolute right-0 mb-3 space-y-3', actionsOffsetClass)}>
          {actions?.map((action) => (
            <Button
              key={action.key}
              size={buttonSize}
              variant="ghost"
              className={cn('flex items-center justify-center border border-black/20 bg-white shadow-lg transition-all hover:bg-[#f5f5f5]', 'px-0', 'aspect-square')}
              onClick={action.onClick}
            >
              <i className={cn(action.iconClass, 'text-xl')}></i>
            </Button>
          ))}
        </div>
      ) : null}

      <Button
        size={buttonSize}
        variant="ghost"
        onClick={() => {
          if (hasActions) {
            onOpenChange?.(!open);
            return;
          }
          onClick();
        }}
        className={cn(
          hasActions
            ? 'flex items-center justify-center bg-black text-white shadow-2xl transition-all hover:bg-[#474747] px-0 aspect-square'
            : 'inline-flex min-w-14 items-center justify-center gap-2 rounded-full bg-black px-5 text-white shadow-sm transition-colors hover:bg-[#474747]',
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
      </Button>
    </div>
  );
}
