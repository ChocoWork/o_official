"use client";

import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';

export interface DropdownItem {
  key: string;
  label: string;
  iconClass?: string;
  hasDividerBefore?: boolean;
  onSelect: () => void;
}

export interface DropdownProps {
  triggerLabel: string;
  items: DropdownItem[];
  className?: string;
}

export function Dropdown({ triggerLabel, items, className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className={cn('relative inline-block', className)} ref={menuRef}>
      <button
        type="button"
        className="flex cursor-pointer items-center gap-2 whitespace-nowrap border border-black px-8 py-3 text-sm tracking-widest text-black transition-all duration-300 hover:bg-black hover:text-white"
        style={{ fontFamily: 'acumin-pro, sans-serif' }}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerLabel}
        <div className="flex h-4 w-4 items-center justify-center">
          <i className="ri-arrow-down-s-line text-base"></i>
        </div>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-2 w-56 border border-black/20 bg-white shadow-lg">
          {items.map((item) => (
            <div key={item.key}>
              {item.hasDividerBefore ? <div className="my-1 h-px bg-black/10"></div> : null}
              <button
                type="button"
                className="w-full cursor-pointer px-6 py-3 text-left text-sm text-black transition-colors hover:bg-[#f5f5f5]"
                style={{ fontFamily: 'acumin-pro, sans-serif' }}
                onClick={() => {
                  item.onSelect();
                  setOpen(false);
                }}
              >
                <div className="flex items-center gap-3">
                  {item.iconClass ? (
                    <div className="flex h-5 w-5 items-center justify-center">
                      <i className={cn(item.iconClass, 'text-xl')}></i>
                    </div>
                  ) : null}
                  <span>{item.label}</span>
                </div>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
