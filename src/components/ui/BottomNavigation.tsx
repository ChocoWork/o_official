import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';

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
  /** コンポーネントのサイズ。sm/md/lg。デフォルトは 'md'。 */
  size?: ComponentSize;
}

export function BottomNavigation({
  items,
  activeKey,
  onChange,
  fixed = true,
  appearance = 'filled',
  className,
  size = 'md',
}: BottomNavigationProps) {
  const isMinimal = appearance === 'minimal';

  // size-based helpers
  const iconContainerMap: Record<ComponentSize, string> = {
    sm: 'h-5 w-5',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };
  const iconTextMap: Record<ComponentSize, string> = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-3xl',
  };
  const labelTextMap: Record<ComponentSize, string> = {
    sm: 'text-[10px]',
    md: 'text-xs',
    lg: 'text-sm',
  };
  const gapMap: Record<ComponentSize, string> = {
    sm: 'gap-0.5',
    md: 'gap-1',
    lg: 'gap-1.5',
  };
  const paddingMap: Record<ComponentSize, string> = {
    sm: 'px-2 py-1',
    md: 'px-2 py-2',
    lg: 'px-3 py-3',
  };

  const iconContainer = iconContainerMap[size];
  const iconText = iconTextMap[size];
  const labelText = labelTextMap[size];
  const gapSize = gapMap[size];
  const btnPadding = paddingMap[size];

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
            ? `flex items-center justify-around py-3`
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
                  ? `flex flex-col items-center ${gapSize} cursor-pointer group`
                  : `flex w-full flex-col items-center justify-center ${gapSize} rounded ${btnPadding} transition-colors`,
                !isMinimal
                  ? item.key === activeKey
                    ? 'bg-black text-white'
                    : 'text-black hover:bg-black/5'
                  : null,
              )}
              aria-current={item.key === activeKey ? 'page' : undefined}
            >
              {item.icon ? (
                item.icon
              ) : item.iconClass ? (
                <span className={cn('flex items-center justify-center', iconContainer)}>
                  <i
                    className={cn(
                      item.iconClass,
                      iconText,
                      'transition-colors',
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
                  labelText,
                  isMinimal ? 'tracking-wider transition-colors' : null,
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
