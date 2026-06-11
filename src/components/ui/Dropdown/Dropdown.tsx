// File: src/components/ui/Dropdown/Dropdown.tsx
'use client';

import '@/components/ui/Dropdown/Dropdown.css';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import type { DropdownItem, DropdownProps } from '@/components/ui/Dropdown/Dropdown_type';

export function Dropdown({
  triggerLabel,
  items,
  className,
  size = 'md',
  openOnHover = false,
  align = 'left',
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const rootDataAttrs = {
    'data-ui-dropdown': 'true',
    'data-ui-dropdown-size': size,
    'data-ui-size': size,
    'data-ui-dropdown-align': align,
    'data-ui-dropdown-open': open ? 'true' : undefined,
  } as const;

  const handleSelect = (item: DropdownItem) => {
    item.onSelect();
    setOpen(false);
  };

  return (
    <div
      className={cn('dropdown', className)}
      ref={rootRef}
      {...rootDataAttrs}
      onMouseEnter={() => {
        if (openOnHover) setOpen(true);
      }}
      onMouseLeave={() => {
        if (openOnHover) setOpen(false);
      }}
    >
      {openOnHover ? (
        <div
          className="dropdown__trigger dropdown__trigger--bare"
          onClick={() => setOpen((current) => !current)}
        >
          {triggerLabel}
        </div>
      ) : (
        <button
          type="button"
          className="dropdown__trigger dropdown__trigger--button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="dropdown__trigger-label">{triggerLabel}</span>
          <span className="dropdown__trigger-caret" aria-hidden="true">
            <i className="ri-arrow-down-s-line" />
          </span>
        </button>
      )}

      {open ? (
        <div className="dropdown__menu" role="menu">
          {items.map((item) => (
            <div key={item.key} className="dropdown__item-wrap">
              {item.hasDividerBefore ? (
                <span className="dropdown__divider" aria-hidden="true" />
              ) : null}
              <button
                type="button"
                className="dropdown__item"
                role="menuitem"
                onClick={() => handleSelect(item)}
              >
                {item.iconClass ? (
                  <span className="dropdown__item-icon" aria-hidden="true">
                    <i className={item.iconClass} />
                  </span>
                ) : null}
                <span className="dropdown__item-label">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}