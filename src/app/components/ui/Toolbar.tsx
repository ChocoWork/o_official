import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface ToolbarItem {
  key: string;
  iconClass: string;
  label?: string;
  onClick?: () => void;
}

export interface ToolbarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  leftItems?: readonly ToolbarItem[];
  rightItems?: readonly ToolbarItem[];
  splitIndex?: number;
  variant?: 'default' | 'muted';
  className?: string;
}

export function Toolbar({
  left,
  center,
  right,
  leftItems,
  rightItems,
  splitIndex,
  variant = 'default',
  className,
}: ToolbarProps) {
  const renderItem = (item: ToolbarItem) => (
    <button
      key={item.key}
      type="button"
      onClick={item.onClick}
      className={cn(
        'flex h-10 items-center justify-center gap-2 transition-colors cursor-pointer',
        item.label ? 'px-4 py-2 hover:bg-white/50' : 'w-10 hover:bg-[#f5f5f5]',
      )}
    >
      <div className="flex h-5 w-5 items-center justify-center">
        <i className={cn(item.iconClass, 'text-xl')}></i>
      </div>
      {item.label ? <span className="text-sm" style={{ fontFamily: 'acumin-pro, sans-serif' }}>{item.label}</span> : null}
    </button>
  );

  const builtLeft = leftItems ? (
    <>
      {leftItems.map((item, index) => (
        <div key={item.key} className="flex items-center">
          {splitIndex !== undefined && index === splitIndex ? <div className="mx-2 h-6 w-px bg-black/20"></div> : null}
          {renderItem(item)}
        </div>
      ))}
    </>
  ) : left;

  const builtRight = rightItems ? <>{rightItems.map((item) => renderItem(item))}</> : right;

  return (
    <header
      className={cn(
        'flex items-center justify-between border border-black/20 p-4',
        variant === 'muted' ? 'bg-[#f5f5f5]' : 'bg-white',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{builtLeft}</div>
      <div className="flex min-w-0 flex-1 items-center justify-center">{center}</div>
      <div className="flex min-w-0 items-center justify-end gap-2">{builtRight}</div>
    </header>
  );
}
