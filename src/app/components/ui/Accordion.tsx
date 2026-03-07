"use client";

import { cn } from '@/lib/utils';
import { useState, type ReactNode } from 'react';
import { ComponentSize } from './types';

export interface AccordionItem {
  key: string;
  title: string;
  content: ReactNode;
  className?: string;
}

export interface AccordionProps {
  items: readonly AccordionItem[];
  openKey?: string | null;
  onOpenChange?: (key: string | null) => void;
  className?: string;
  itemClassName?: string;
  triggerClassName?: string;
  contentClassName?: string;
  /** demo-compatible size modifier */
  size?: ComponentSize;
}

export function Accordion({
  items,
  openKey,
  onOpenChange,
  className,
  itemClassName,
  triggerClassName,
  contentClassName,
  size = 'md',
}: AccordionProps) {
  const [internalOpenKey, setInternalOpenKey] = useState<string | null>(null);
  const currentOpenKey = openKey !== undefined ? openKey : internalOpenKey;

  const setCurrentOpenKey = (key: string | null) => {
    if (onOpenChange) {
      onOpenChange(key);
      return;
    }
    setInternalOpenKey(key);
  };

  // maps for size adjustments
  const triggerPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-2',
    md: 'px-6 py-3',
    lg: 'px-8 py-4',
  };
  const contentPaddingMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-0.5 pb-1',
    md: 'px-6 py-1 pb-2',
    lg: 'px-8 py-1.5 pb-3',
  };
  const textSizeMap: Record<ComponentSize, string> = {
    // md should match original implementation (text-sm)
    sm: 'text-sm',
    md: 'text-sm',
    lg: 'text-lg',
  };
  const iconSizeMap: Record<ComponentSize, string> = {
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-2xl',
  };
  const iconContainerSizeMap: Record<ComponentSize, string> = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };

  return (
    <div className={cn('max-w-2xl border border-black/20', className)}>
      {items.map((item, index) => {
        const isOpen = currentOpenKey === item.key;

        return (
          <div
            key={item.key}
            className={cn(index < items.length - 1 ? 'border-b border-black/10' : null, itemClassName, item.className)}
          >
            <button
              type="button"
              className={cn(
                'flex w-full cursor-pointer items-center justify-between text-left transition-colors hover:bg-[#f5f5f5]',
                triggerPaddingMap[size],
                triggerClassName,
              )}
              onClick={() => setCurrentOpenKey(isOpen ? null : item.key)}
            >
              <span
                className={cn(textSizeMap[size], 'tracking-wide text-black')}
                style={{ fontFamily: 'acumin-pro, sans-serif' }}
              >
                {item.title}
              </span>
              <div
                className={cn(
                  'flex items-center justify-center',
                  iconContainerSizeMap[size]
                )}
              >
                <i
                  className={cn(
                    `ri-arrow-${isOpen ? 'up' : 'down'}-s-line`,
                    iconSizeMap[size],
                    'transition-transform'
                  )}
                />
              </div>
            </button>
            {isOpen ? (
              <div className={cn(contentPaddingMap[size], contentClassName)}>
                <div className="text-sm leading-relaxed text-black/60" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                  {item.content}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
