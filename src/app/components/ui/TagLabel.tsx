import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface TagLabelProps {
  children: ReactNode;
  variant?: 'solid' | 'outline' | 'subtle';
  rounded?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
}

export function TagLabel({
  children,
  variant = 'outline',
  rounded = false,
  removable = false,
  onRemove,
  className,
}: TagLabelProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-3 py-1 text-xs tracking-widest',
        removable ? 'gap-2' : null,
        variant === 'solid' ? 'bg-black text-white' : null,
        variant === 'outline' ? 'border border-black text-black' : null,
        variant === 'subtle' ? 'bg-[#f5f5f5] text-black' : null,
        rounded ? 'rounded-full' : null,
        className,
      )}
      style={{ fontFamily: 'acumin-pro, sans-serif' }}
    >
      {children}
      {removable && onRemove ? (
        <button
          type="button"
          className="flex h-4 w-4 cursor-pointer items-center justify-center transition-colors hover:bg-black/10"
          onClick={onRemove}
        >
          <i className="ri-close-line text-sm"></i>
        </button>
      ) : null}
    </span>
  );
}
