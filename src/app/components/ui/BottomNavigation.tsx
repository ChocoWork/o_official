import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface BottomNavigationItem {
  key: string;
  label: string;
  icon?: ReactNode;
}

export interface BottomNavigationProps {
  items: BottomNavigationItem[];
  activeKey: string;
  onChange: (key: string) => void;
  fixed?: boolean;
  className?: string;
}

export function BottomNavigation({ items, activeKey, onChange, fixed = true, className }: BottomNavigationProps) {
  return (
    <nav className={cn(fixed ? 'fixed bottom-0 left-0 right-0 z-40 border-t border-black/10 bg-white p-2 lg:hidden' : 'border border-black/20 bg-white p-2', className)}>
      <ul className="grid grid-cols-4 gap-1">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onChange(item.key)}
              className={cn(
                'flex w-full flex-col items-center justify-center gap-1 rounded px-2 py-2 text-xs',
                item.key === activeKey ? 'bg-black text-white' : 'text-black hover:bg-black/5',
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
