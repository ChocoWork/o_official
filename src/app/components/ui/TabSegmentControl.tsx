import { cn } from '@/lib/utils';

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
}

export function TabSegmentControl({ items, activeKey, onChange, variant = 'segment', className }: TabSegmentControlProps) {
  if (variant === 'tabs-standard') {
    return (
      <div className={cn('flex items-center gap-8', className)} role="tablist">
        {items.map((item) => {
          const isActive = item.key === activeKey;

          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={cn(
                'relative cursor-pointer pb-4 text-sm tracking-widest transition-colors',
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
      <div className={cn('inline-flex items-center rounded-full bg-[#f5f5f5] p-1', className)}>
        {items.map((item) => {
          const isActive = item.key === activeKey;

          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(item.key)}
              className={cn(
                'cursor-pointer whitespace-nowrap rounded-full px-6 py-2 text-xs tracking-widest transition-all',
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
        variant === 'segment' ? 'inline-flex overflow-hidden border border-black/20 bg-white' : 'inline-flex border-b border-black/20',
        className,
      )}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={cn(
            variant === 'segment' ? 'px-4 py-2 text-xs tracking-widest transition-colors' : 'relative px-4 pb-4 text-sm tracking-widest transition-colors',
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
