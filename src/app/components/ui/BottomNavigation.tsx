import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface BottomNavigationItem {
  key: string;
  label?: string;
  icon?: ReactNode;
  iconClass?: string;
}

export interface BottomNavigationProps {
  items: BottomNavigationItem[];
  activeKey: string;
  onChange: (key: string) => void;
  fixed?: boolean;
  appearance?: 'filled' | 'minimal';
  className?: string;
}

export function BottomNavigation({
  items,
  activeKey,
  onChange,
  fixed = true,
  appearance = 'filled',
  className,
}: BottomNavigationProps) {
  const isMinimal = appearance === 'minimal';

  return (
    <nav
      className={cn(
        fixed ? 'fixed bottom-0 left-0 right-0 z-40 border-t border-black/10 bg-white p-2 lg:hidden' : 'border border-black/20 bg-white p-2',
        className,
      )}
    >
      <ul
        className={cn(
          isMinimal
            ? 'flex items-center justify-around py-3'
            : 'grid gap-1',
        )}
        style={isMinimal ? undefined : { gridTemplateColumns: `repeat(${Math.max(items.length, 1)}, minmax(0, 1fr))` }}
      >
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onChange(item.key)}
              className={cn(
                isMinimal
                  ? 'flex flex-col items-center gap-1 cursor-pointer group'
                  : 'flex w-full flex-col items-center justify-center gap-1 rounded px-2 py-2 transition-colors',
                !isMinimal
                  ? item.key === activeKey
                    ? 'bg-black text-white text-xs'
                    : 'text-black text-xs hover:bg-black/5'
                  : null,
              )}
              aria-current={item.key === activeKey ? 'page' : undefined}
            >
              {item.icon ? (
                item.icon
              ) : item.iconClass ? (
                <span className="flex h-6 w-6 items-center justify-center">
                  <i
                    className={cn(
                      item.iconClass,
                      'text-2xl transition-colors',
                      isMinimal
                        ? item.key === activeKey
                          ? 'text-black'
                          : 'text-black/40 group-hover:text-black/60'
                        : null,
                    )}
                  ></i>
                </span>
              ) : null}
              <span
                className={cn(
                  isMinimal
                    ? item.key === activeKey
                      ? 'text-black'
                      : 'text-black/40 group-hover:text-black/60'
                    : null,
                  isMinimal ? 'text-[10px] tracking-wider transition-colors' : null,
                )}
              >
                {item.label ?? item.key}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
