"use client";

import { cn } from '@/lib/utils';
import { useState, type ReactNode } from 'react';

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
}

export function Accordion({
  items,
  openKey,
  onOpenChange,
  className,
  itemClassName,
  triggerClassName,
  contentClassName,
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
                'flex w-full cursor-pointer items-center justify-between px-6 py-5 text-left transition-colors hover:bg-[#f5f5f5]',
                triggerClassName,
              )}
              onClick={() => setCurrentOpenKey(isOpen ? null : item.key)}
            >
              <span className="text-sm tracking-wide text-black" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                {item.title}
              </span>
              <div className="flex h-5 w-5 items-center justify-center">
                <i className={cn(`ri-arrow-${isOpen ? 'up' : 'down'}-s-line`, 'text-xl transition-transform')}></i>
              </div>
            </button>
            {isOpen ? (
              <div className={cn('px-6 pb-5', contentClassName)}>
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
