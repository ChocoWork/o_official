import { cn } from '@/lib/utils';

export interface TabSegmentControlItem {
  key: string;
  label: string;
}

export interface TabSegmentControlProps {
  items: TabSegmentControlItem[];
  activeKey: string;
  onChange: (key: string) => void;
  variant?: 'segment' | 'tabs';
}

export function TabSegmentControl({ items, activeKey, onChange, variant = 'segment' }: TabSegmentControlProps) {
  return (
    <div className={cn(variant === 'segment' ? 'inline-flex overflow-hidden border border-black/20 bg-white' : 'inline-flex border-b border-black/20')}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={cn(
            variant === 'segment' ? 'px-4 py-2 text-xs tracking-widest transition-colors' : 'relative px-4 pb-4 text-sm tracking-widest transition-colors',
            variant === 'segment'
              ? (item.key === activeKey ? 'bg-black text-white' : 'text-black hover:bg-black/5')
              : (item.key === activeKey ? 'text-black after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-black' : 'text-black/40 hover:text-black/60'),
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
