"use client";

import { cn } from '@/lib/utils';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import type { UIButtonSize } from './Button';
import { ComponentSize } from './types';

export interface DropdownItem {
  key: string;
  label: string;
  iconClass?: string;
  hasDividerBefore?: boolean;
  onSelect: () => void;
}

export interface DropdownProps {
  // triggerLabel can be text or any React element (icon etc.)
  triggerLabel: React.ReactNode;
  items: DropdownItem[];
  className?: string;
  size?: ComponentSize;
  /** when true, menu opens on hover instead of click */
  openOnHover?: boolean;
  /** alignment of menu relative to trigger: left or right */
  align?: 'left' | 'right';
}

export function Dropdown({ triggerLabel, items, className, size = 'md', openOnHover = false, align = 'left' }: DropdownProps) {
  const buttonSizeMap: Record<ComponentSize, UIButtonSize> = {
    sm: 'sm',
    md: 'md',
    lg: 'lg',
  };
  const buttonSize = buttonSizeMap[size];
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

  // size mappings
  const triggerClassMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-2 text-xs gap-1',
    md: 'px-8 py-3 text-sm gap-2',
    lg: 'px-10 py-4 text-base gap-3',
  };
  const itemClassMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-2 text-xs',
    md: 'px-6 py-3 text-sm',
    lg: 'px-8 py-4 text-base',
  };
  const menuWidthMap: Record<ComponentSize, string> = {
    sm: 'w-40',
    md: 'w-56',
    lg: 'w-64',
  };

  return (
    <div
      className={cn('relative inline-block', className)}
      ref={menuRef}
      onMouseEnter={() => {
        if (openOnHover) setOpen(true);
      }}
      onMouseLeave={() => {
        if (openOnHover) setOpen(false);
      }}
    >
      {openOnHover ? (
        <div className="cursor-pointer inline-flex items-center" onClick={() => setOpen((c) => !c)}>
          {triggerLabel}
        </div>
      ) : (
        <Button
          size={buttonSize}
          variant="ghost"
          className={cn(
            'flex cursor-pointer items-center whitespace-nowrap border border-black tracking-widest text-black transition-all duration-300 hover:bg-black hover:text-white',
            triggerClassMap[size],
          )}
          style={{ fontFamily: 'acumin-pro, sans-serif' }}
          onClick={() => setOpen((current) => !current)}
        >
          {triggerLabel}
          <div className="flex h-4 w-4 items-center justify-center">
            <i className="ri-arrow-down-s-line text-base"></i>
          </div>
        </Button>
      )}
      {open ? (
        <div
          className={cn(
            'absolute top-full z-10 mt-2 border border-black/20 bg-white shadow-lg',
            menuWidthMap[size],
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.hasDividerBefore ? <div className="my-1 h-px bg-black/10"></div> : null}
              <Button
                size={buttonSize}
                variant="ghost"
                className={cn('w-full cursor-pointer justify-start text-left text-black transition-colors hover:bg-[#f5f5f5]', itemClassMap[size])}
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
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
