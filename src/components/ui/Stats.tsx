import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ComponentSize } from './types';

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
  /** コンポーネントサイズ。sm/md/lg。デフォルト md。 */
  size?: ComponentSize;
}

export function Stats({ items, className, cardClassName, valueClassName, labelClassName, size = 'md' }: StatsProps) {
  const padMap: Record<ComponentSize, string> = {
    sm: 'p-4',
    md: 'p-6',
    lg: 'p-8',
  };
  const iconMap: Record<ComponentSize, string> = {
    sm: 'h-6 w-6 text-xl',
    md: 'h-10 w-10 text-2xl',
    lg: 'h-12 w-12 text-3xl',
  };
  const valueMap: Record<ComponentSize, string> = {
    sm: 'text-2xl',
    md: 'text-3xl',
    lg: 'text-4xl',
  };

  const pad = padMap[size];
  const iconCls = iconMap[size];
  const valueCls = valueMap[size];

  return (
    <div className={cn('grid grid-cols-1 gap-6 md:grid-cols-4', className)}>
      {items.map((item) => (
        <div
          key={item.label}
          className={cn('border border-black/20 transition-colors hover:border-black', pad, cardClassName)}
        >
          {item.icon ? (
            <div className={cn('mb-4 flex items-center justify-center text-black', iconCls)}>{item.icon}</div>
          ) : null}
          <p
            className={cn('mb-2 text-black', valueCls, valueClassName)}
            style={{ fontFamily: 'Didot, serif' }}
          >
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
