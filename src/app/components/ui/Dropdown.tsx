import { cn } from '@/lib/utils';

export interface DropdownItem {
  key: string;
  label: string;
  onSelect: () => void;
}

export interface DropdownProps {
  triggerLabel: string;
  items: DropdownItem[];
  className?: string;
}

export function Dropdown({ triggerLabel, items, className }: DropdownProps) {
  return (
    <details className={cn('relative', className)}>
      <summary className="cursor-pointer list-none border border-black px-3 py-2 text-xs tracking-widest">{triggerLabel}</summary>
      <div className="absolute right-0 z-30 mt-2 min-w-44 border border-black/10 bg-white p-1 shadow-sm">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.onSelect}
            className="block w-full px-3 py-2 text-left text-sm text-black hover:bg-black/5"
          >
            {item.label}
          </button>
        ))}
      </div>
    </details>
  );
}
