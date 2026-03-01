import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface StatItem {
  label: string;
  value: string;
  icon?: ReactNode;
}

export interface StatsProps {
  items: readonly StatItem[];
  className?: string;
  cardClassName?: string;
  valueClassName?: string;
  labelClassName?: string;
}

export function Stats({ items, className, cardClassName, valueClassName, labelClassName }: StatsProps) {
  return (
    <div className={cn('grid grid-cols-1 gap-6 md:grid-cols-4', className)}>
      {items.map((item) => (
        <div
          key={item.label}
          className={cn('border border-black/20 p-6 transition-colors hover:border-black', cardClassName)}
        >
          {item.icon ? <div className="mb-4 flex h-10 w-10 items-center justify-center text-black">{item.icon}</div> : null}
          <p className={cn('mb-2 text-3xl text-black', valueClassName)} style={{ fontFamily: 'Didot, serif' }}>
            {item.value}
          </p>
          <p
            className={cn('text-xs tracking-widest text-black/60', labelClassName)}
            style={{ fontFamily: 'acumin-pro, sans-serif' }}
          >
            {item.label}
          </p>
        </div>
      ))}
    </div>
  );
}
