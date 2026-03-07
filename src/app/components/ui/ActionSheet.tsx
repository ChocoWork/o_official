import { cn } from '@/lib/utils';
import { ComponentSize } from './types';

export interface ActionSheetAction {
  key: string;
  label: string;
  iconClass?: string;
  destructive?: boolean;
  onSelect: () => void;
}

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  actions: ActionSheetAction[];
  size?: ComponentSize;
}

export function ActionSheet({ open, onClose, actions, size = 'md' }: ActionSheetProps) {
  if (!open) {
    return null;
  }

  // mirror Button component sizing
  const heightClassMap: Record<ComponentSize, string> = {
    sm: 'h-8',
    md: 'h-10',
    lg: 'h-12',
  };
  const buttonPaddingMap: Record<ComponentSize, string> = {
    // horizontal padding matches Button px; vertical padding minimal since we enforce height
    sm: 'px-3',
    md: 'px-4',
    lg: 'px-5',
  };
  const buttonTextMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-sm',
  };
  const iconSizeMap: Record<ComponentSize, string> = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };
  const gapMap: Record<ComponentSize, string> = {
    sm: 'gap-2',
    md: 'gap-3',
    lg: 'gap-4',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40"></div>
      <div
        className="relative mb-4 mx-4 w-full max-w-md bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-2">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => {
                action.onSelect();
                onClose();
              }}
              className={cn(
                'w-full cursor-pointer text-left transition-colors hover:bg-[#f5f5f5]',
                heightClassMap[size],
                buttonPaddingMap[size],
                buttonTextMap[size],
                action.destructive ? 'text-red-600' : 'text-black',
              )}
              style={{ fontFamily: 'acumin-pro, sans-serif' }}
            >
              <div className={cn('flex items-center', gapMap[size])}>
                {action.iconClass ? (
                  <div className={cn('flex items-center justify-center', iconSizeMap[size])}>
                    <i className={cn(action.iconClass, 'text-xl')}></i>
                  </div>
                ) : null}
                <span>{action.label}</span>
              </div>
            </button>
          ))}
          <div className="my-2 h-px bg-black/10"></div>
          <button
            type="button"
            className={cn(
              'w-full cursor-pointer text-left text-black transition-colors hover:bg-[#f5f5f5]',
              heightClassMap[size],
              buttonPaddingMap[size],
              buttonTextMap[size],
            )}
            style={{ fontFamily: 'acumin-pro, sans-serif' }}
            onClick={onClose}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
