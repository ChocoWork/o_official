import { cn } from '@/lib/utils';

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
}

export function ActionSheet({ open, onClose, actions }: ActionSheetProps) {
  if (!open) {
    return null;
  }

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
                'w-full cursor-pointer px-6 py-4 text-left text-sm transition-colors hover:bg-[#f5f5f5]',
                action.destructive ? 'text-red-600' : 'text-black',
              )}
              style={{ fontFamily: 'acumin-pro, sans-serif' }}
            >
              <div className="flex items-center gap-3">
                {action.iconClass ? (
                  <div className="flex h-5 w-5 items-center justify-center">
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
            className="w-full cursor-pointer px-6 py-4 text-left text-sm text-black transition-colors hover:bg-[#f5f5f5]"
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
