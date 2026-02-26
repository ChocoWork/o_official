import { cn } from '@/lib/utils';
import { Button } from './Button';

export interface ActionSheetAction {
  key: string;
  label: string;
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
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div className="absolute bottom-0 left-0 right-0 mx-auto max-w-2xl border border-black/10 bg-white p-3" onClick={(event) => event.stopPropagation()}>
        <div className="space-y-2">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={() => {
                action.onSelect();
                onClose();
              }}
              className={cn(
                'w-full border border-black/10 px-4 py-3 text-left text-sm hover:bg-black/5',
                action.destructive ? 'text-red-600' : 'text-black',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
        <Button variant="secondary" className="mt-2 w-full" onClick={onClose}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}
