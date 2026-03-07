import { cn } from '@/lib/utils';
import { controlBaseClass } from './shared';
import type { InputHTMLAttributes } from 'react';
import { ComponentSize } from './types';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  showClearButton?: boolean;
  onClear?: () => void;
  size?: ComponentSize;
}

export function SearchField({ label, showClearButton = false, onClear, className, value, size = 'md', ...props }: SearchFieldProps) {
  const hasValue = typeof value === 'string' && value.length > 0;
  const sizeClassMap: Record<ComponentSize, string> = {
    sm: 'h-8',
    md: 'h-10',
    lg: 'h-12',
  };
  const widthPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-2',
    md: 'px-4',
    lg: 'px-6',
  };
  const iconLeftMap: Record<ComponentSize, string> = {
    sm: 'left-3',
    md: 'left-4',
    lg: 'left-5',
  };
  const iconSizeMap: Record<ComponentSize, string> = {
    sm: 'h-3.5 w-3.5 text-sm',
    md: 'h-4 w-4 text-base',
    lg: 'h-5 w-5 text-lg',
  };
  const clearRightMap: Record<ComponentSize, string> = {
    sm: 'right-3',
    md: 'right-4',
    lg: 'right-5',
  };
  const sizeClass = sizeClassMap[size];
  const widthPaddingClass = widthPaddingMap[size];
  const iconLeftClass = iconLeftMap[size];
  const iconSizeClass = iconSizeMap[size];
  const clearRightClass = clearRightMap[size];

  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <div className={`relative ${sizeClass}`}>
        <span className={cn('pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center', iconLeftClass, iconSizeClass)}>
          <i className="ri-search-line text-black/60"></i>
        </span>
        <input
          type="search"
          value={value}
          className={cn(
            controlBaseClass,
            'h-full py-0',
            widthPaddingClass,
            'search-no-native-clear pl-12',
            showClearButton ? 'pr-12' : 'pr-4',
            className,
          )}
          {...props}
        />
        {showClearButton && hasValue ? (
          <button
            type="button"
            aria-label="入力内容をクリア"
            onClick={onClear}
            className={cn('absolute top-1/2 -translate-y-1/2 cursor-pointer', clearRightClass)}
          >
            <i className="ri-close-line text-base text-black/60 transition-colors hover:text-black"></i>
          </button>
        ) : null}
      </div>
    </label>
  );
}
