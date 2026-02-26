import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface FloatingButtonProps {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  fixed?: boolean;
  className?: string;
}

export function FloatingButton({ icon, label, onClick, fixed = true, className }: FloatingButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-14 min-w-14 items-center justify-center gap-2 rounded-full bg-black px-5 text-white shadow-sm transition-colors hover:bg-[#474747]',
        fixed ? 'fixed bottom-6 right-6 z-40' : null,
        className,
      )}
    >
      {icon}
      <span className="text-xs tracking-wider">{label}</span>
    </button>
  );
}
