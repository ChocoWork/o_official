import { cn } from '@/lib/utils';
import { ComponentSize } from './types';

export interface TabSegmentControlItem {
  key: string;
  label: string;
}

export interface TabSegmentControlProps {
  items: TabSegmentControlItem[];
  activeKey: string;
  onChange: (key: string) => void;
  variant?: 'segment' | 'tabs' | 'segment-pill' | 'tabs-standard';
  className?: string;
  size?: ComponentSize;
  orientation?: 'horizontal' | 'vertical';
}

export function TabSegmentControl({
  items,
  activeKey,
  onChange,
  variant = 'segment',
  className,
  size = 'md',
  orientation = 'horizontal',
}: TabSegmentControlProps) {
  // utility maps
  const textSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-xs',
    lg: 'text-sm',
  };
  // md gap should match original non-size version (gap-8)
  const gapMap: Record<ComponentSize, string> = {
    sm: 'gap-2',
    md: 'gap-8',
    lg: 'gap-6',
  };
  const pillPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-1.5',
    md: 'px-6 py-2',
    lg: 'px-7 py-2',
  };
  const segmentPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-2 py-1',
    md: 'px-4 py-2',
    lg: 'px-5 py-2.5',
  };

  // when vertical orientation requested we render simple stacked buttons
  if (orientation === 'vertical') {
    return (
      <div className={cn('flex flex-col', className)} role="tablist">
        {items.map((item) => {
          const isActive = item.key === activeKey;
          return (
            <button
              key={item.key}
              type="button"
              className={cn(
                'w-full text-left px-6 py-4 text-sm tracking-wider transition-colors cursor-pointer',
                isActive
                  ? 'bg-black text-white'
                  : 'bg-[#f5f5f5] text-black hover:bg-[#e5e5e5]'
              )}
              onClick={() => onChange(item.key)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'tabs-standard') {
    return (
      <div
        className={cn(
          'flex',
          ((orientation as string) === 'vertical' ? 'flex-col' : 'items-center') as string,
          gapMap[size],
          className,
        )}
        role="tablist"
      >
        {items.map((item) => {
          const isActive = item.key === activeKey;

          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={cn(
                'relative cursor-pointer pb-4 tracking-widest transition-colors',
                // tabs-standard originally always text-sm regardless of size
                size === 'md' ? 'text-sm' : textSizeMap[size],
                isActive ? 'text-black' : 'text-black/40 hover:text-black/60',
              )}
              onClick={() => onChange(item.key)}
            >
              {item.label}
              {isActive ? <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-black"></span> : null}
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === 'segment-pill') {
    return (
      <div
        className={cn(
          'inline-flex items-center rounded-full bg-[#f5f5f5] p-1',
          ((orientation as string) === 'vertical' ? 'flex-col' : '') as string,
          className,
        )}
      >
        {items.map((item) => {
          const isActive = item.key === activeKey;

          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(item.key)}
              className={cn(
                'cursor-pointer whitespace-nowrap rounded-full tracking-widest transition-all',
                pillPaddingMap[size],
                textSizeMap[size],
                isActive ? 'bg-black text-white' : 'text-black/60 hover:text-black',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        variant === 'segment'
          ? 'inline-flex overflow-hidden border border-black/20 bg-white'
          : 'inline-flex border-b border-black/20',
        // @ts-expect-error: comparison against literal union causes spurious warning
        (orientation === 'vertical' ? 'flex-col' : '') as string,
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={cn(
            variant === 'segment'
              ? cn(segmentPaddingMap[size], textSizeMap[size], 'tracking-widest transition-colors')
              : cn('relative', segmentPaddingMap[size], textSizeMap[size], 'tracking-widest transition-colors pb-4'),
            variant === 'segment'
              ? item.key === activeKey
                ? 'bg-black text-white'
                : 'text-black hover:bg-black/5'
              : item.key === activeKey
                ? 'text-black after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-black'
                : 'text-black/40 hover:text-black/60',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
