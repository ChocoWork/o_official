import { cn } from '@/lib/utils';
import { controlBaseClass } from './shared';
import type { InputHTMLAttributes } from 'react';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  showClearButton?: boolean;
  onClear?: () => void;
}

export function SearchField({ label, showClearButton = false, onClear, className, value, ...props }: SearchFieldProps) {
  const hasValue = typeof value === 'string' && value.length > 0;

  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center">
          <i className="ri-search-line text-base text-black/60"></i>
        </span>
        <input
          type="search"
          value={value}
          className={cn(controlBaseClass, 'search-no-native-clear pl-12', showClearButton ? 'pr-12' : 'pr-4', className)}
          {...props}
        />
        {showClearButton && hasValue ? (
          <button
            type="button"
            aria-label="入力内容をクリア"
            onClick={onClear}
            className="absolute right-4 top-1/2 -translate-y-1/2 cursor-pointer"
          >
            <i className="ri-close-line text-base text-black/60 transition-colors hover:text-black"></i>
          </button>
        ) : null}
      </div>
    </label>
  );
}
