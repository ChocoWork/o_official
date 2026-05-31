"use client";
import "@/components/ui/Accordion/Accordion.css"
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { AccordionProps } from '@/components/ui/Accordion/Accordion_types';

export function Accordion({
  items,
  openKey,
  onOpenChange,
  className,
  itemClassName,
  triggerClassName,
  contentClassName,
  size = 'md',
  highlightOnHover = true,
  showUnderline = true,
  openMode = 'single',
  defaultOpenKeys = [],
}: AccordionProps) {
  const [internalOpenKey, setInternalOpenKey] = useState<string | null>(() => defaultOpenKeys[0] ?? null);
  const [internalOpenKeys, setInternalOpenKeys] = useState<string[]>(() => [...defaultOpenKeys]);
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
    <div
      data-ui-accordion
      data-ui-accordion-size={size}
      data-ui-accordion-hover-highlight={highlightOnHover ? 'true' : 'false'}
      data-ui-accordion-show-underline={showUnderline ? 'true' : 'false'}
      className={className}
    >
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
