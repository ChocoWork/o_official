import { cn } from '@/lib/utils';
import { Search } from 'lucide-react';
import { controlBaseClass } from './shared';
import type { TextFieldProps } from './TextField';

export interface SearchFieldProps extends Omit<TextFieldProps, 'type'> {
  onClear?: () => void;
}

export function SearchField({ onClear, className, ...props }: SearchFieldProps) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#474747]" />
      <input type="search" className={cn(controlBaseClass, 'pl-12 pr-10', className)} {...props} />
      {onClear ? (
        <button
          type="button"
          aria-label="clear-search"
          onClick={onClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#474747] hover:text-black"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
