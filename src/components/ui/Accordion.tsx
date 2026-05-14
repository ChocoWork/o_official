"use client";

import { cn } from '@/lib/utils';
import { useState, type ReactNode } from 'react';
import { ComponentSize } from './types';

export interface AccordionItem {
  key: string;
  /** Title can be a string or React element; commonly used for radio + label layout */
  title: ReactNode;
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
  /** #sym:size: single keeps current behavior, multiple allows opening multiple items */
  openMode?: 'single' | 'multiple';
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
  openMode = 'single',
}: AccordionProps) {
  const [internalOpenKey, setInternalOpenKey] = useState<string | null>(null);
  const [internalOpenKeys, setInternalOpenKeys] = useState<string[]>([]);
  const currentOpenKey = openKey !== undefined ? openKey : internalOpenKey;

  const setCurrentOpenKey = (key: string | null) => {
    if (onOpenChange) {
      onOpenChange(key);
      return;
    }
    setInternalOpenKey(key);
  };

  const toggleOpenKey = (key: string, isOpen: boolean) => {
    if (openMode === 'multiple') {
      setInternalOpenKeys((prev) =>
        isOpen ? prev.filter((entry) => entry !== key) : [...prev, key],
      );
      return;
    }
    setCurrentOpenKey(isOpen ? null : key);
  };

  return (
    <div data-ui-accordion data-ui-accordion-size={size} className={className}>
      {items.map((item) => {
        const isOpen =
          openMode === 'multiple'
            ? internalOpenKeys.includes(item.key)
            : currentOpenKey === item.key;

        return (
          <div
            key={item.key}
            data-ui-accordion-item
            className={cn(itemClassName, item.className)}
          >
            <button
              type="button"
              data-ui-accordion-trigger
              aria-expanded={isOpen}
              className={triggerClassName}
              onClick={() => toggleOpenKey(item.key, isOpen)}
            >
              <span data-ui-accordion-title>
                {item.title}
              </span>
              <span data-ui-accordion-icon-wrap aria-hidden="true">
                <i
                  data-ui-accordion-icon
                  className={isOpen ? 'ri-subtract-line' : 'ri-add-line'}
                  aria-hidden="true"
                />
              </span>
            </button>
            {isOpen ? (
              <div data-ui-accordion-content className={contentClassName}>
                <div data-ui-accordion-content-body>
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
