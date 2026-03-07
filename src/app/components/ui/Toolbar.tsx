import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';

export interface ToolbarItem {
  key: string;
  iconClass: string;
  label?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
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
  size?: ComponentSize;
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
  size = 'md',
}: ToolbarProps) {
  const paddingMap: Record<ComponentSize, string> = {
    sm: 'px-2',
    md: 'px-3',
    lg: 'px-4',
  };
  const buttonHeightMap: Record<ComponentSize, string> = {
    sm: 'h-8',
    md: 'h-10',
    lg: 'h-12',
  };
  const iconContainerMap: Record<ComponentSize, string> = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };
  const textSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };
  const gapMap: Record<ComponentSize, string> = {
    sm: 'gap-1',
    md: 'gap-2',
    lg: 'gap-3',
  };
  const labelPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-2 py-1',
    md: 'px-2 py-2',
    lg: 'px-3 py-2',
  };
  const iconOnlyWidthMap: Record<ComponentSize, string> = {
    sm: 'w-8',
    md: 'w-9',
    lg: 'w-11',
  };
  const iconSizeMap: Record<ComponentSize, string> = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
  };
  const splitDividerHeightMap: Record<ComponentSize, string> = {
    sm: 'h-4',
    md: 'h-6',
    lg: 'h-8',
  };
  const labelHoverClass = variant === 'muted' ? 'hover:bg-black/[0.04]' : 'hover:bg-white/50';
  const iconHoverClass = variant === 'muted' ? 'hover:bg-black/[0.04]' : 'hover:bg-[#f5f5f5]';

  const renderItem = (item: ToolbarItem) => (
    <button
      key={item.key}
      type="button"
      onClick={item.onClick}
      className={cn(
        'flex items-center justify-center transition-colors cursor-pointer',
        buttonHeightMap[size],
        gapMap[size],
        item.label
          ? `${labelPaddingMap[size]} ${labelHoverClass}`
          : `${iconOnlyWidthMap[size]} ${iconHoverClass}`,
      )}
    >
      <div className={cn('flex items-center justify-center', iconContainerMap[size])}>
        <i className={cn(item.iconClass, iconSizeMap[size])}></i>
      </div>
      {item.label ? (
        <span className={cn(textSizeMap[size])} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          {item.label}
        </span>
      ) : null}
    </button>
  );

  const builtLeft = leftItems ? (
    <>
      {leftItems.map((item, index) => (
        <div key={item.key} className="flex items-center">
          {splitIndex !== undefined && index === splitIndex ? <div className={cn('mx-2 w-px bg-black/20', splitDividerHeightMap[size])}></div> : null}
          {renderItem(item)}
        </div>
      ))}
    </>
  ) : left;

  const builtRight = rightItems ? <>{rightItems.map((item) => renderItem(item))}</> : right;

  return (
    <header
      className={cn(
        'flex items-center justify-between border border-black/20',
        paddingMap[size],
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
