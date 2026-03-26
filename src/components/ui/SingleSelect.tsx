import { cn } from '@/lib/utils';
import type { SelectHTMLAttributes } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { controlBaseClass, type SelectOption } from './shared';
import { ComponentSize } from './types';

export interface SingleSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  options: SelectOption[];
  placeholder?: string;
  variant?: 'native' | 'dropdown';
  onValueChange?: (value: string) => void;
  size?: ComponentSize;
}

export function SingleSelect({
  label,
  options,
  className,
  id,
  placeholder,
  variant = 'native',
  onValueChange,
  value,
  defaultValue,
  disabled,
  size = 'md',
  ...props
}: SingleSelectProps) {
  const heightClass = size === 'sm' ? 'h-8' : size === 'lg' ? 'h-12' : 'h-10';
  const textClass = size === 'lg' ? 'text-base' : 'text-sm';
  const selectId = id ?? props.name;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const resolvedValue = useMemo(() => {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof defaultValue === 'string') {
      return defaultValue;
    }
    return '';
  }, [defaultValue, value]);

  useEffect(() => {
    if (variant !== 'dropdown' || !open) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedInWrapper = wrapperRef.current?.contains(target);
      const clickedInDropdown = dropdownRef.current?.contains(target);
      if (!clickedInWrapper && !clickedInDropdown) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, variant]);

  // reposition dropdown when it opens
  useEffect(() => {
    if (variant === 'dropdown' && open && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
      });
    } else {
      setDropdownPos(null);
    }
  }, [open, variant]);

  // update position on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      if (wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        setDropdownPos({
          top: rect.bottom + window.scrollY,
          left: rect.left + window.scrollX,
          width: rect.width,
        });
      }
    };
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler);
    };
  }, [open]);

  if (variant === 'dropdown') {
    const optionPadding = size === 'sm' ? 'py-2' : size === 'lg' ? 'py-4' : 'py-3';
    return (
      <label className="block space-y-2">
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
        <div className="relative" ref={wrapperRef}>
          <button
            type="button"
            className={cn(
              controlBaseClass,
              'flex items-center justify-between text-left',
              heightClass,
              textClass,
              disabled ? 'cursor-not-allowed border-black/10 bg-[#f5f5f5] text-black/40' : 'cursor-pointer',
              className,
            )}
            onClick={() => {
              if (!disabled) {
                setOpen((previous) => !previous);
              }
            }}
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={disabled}
          >
            <span>
              {resolvedValue
                ? options.find((opt) => opt.value === resolvedValue)?.label ?? resolvedValue
                : placeholder || '選択してください'}
            </span>
            <span className="flex h-4 w-4 items-center justify-center">
              <i
                className="ri-arrow-down-s-line text-base transition-transform"
                style={{ transform: open ? 'rotate(180deg)' : undefined }}
              ></i>
            </span>
          </button>
          {open && dropdownPos &&
            ReactDOM.createPortal(
              <div
                ref={dropdownRef}
                style={{
                  position: 'absolute',
                  top: dropdownPos.top,
                  left: dropdownPos.left,
                  width: dropdownPos.width,
                }}
                className="z-10 mt-1 border border-black/20 bg-white shadow-lg"
              >
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      'w-full cursor-pointer px-4',
                      optionPadding,
                      textClass,
                      'text-left transition-colors hover:bg-[#f5f5f5]',
                      resolvedValue === option.value ? 'bg-[#f5f5f5]' : null,
                    )}
                    onClick={() => {
                      onValueChange?.(option.value);
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>,
              document.body,
            )}

        </div>
      </label>
    );
  }

  return (
    <label className="block space-y-2">
      {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
      <select
        id={selectId}
        className={cn(controlBaseClass, 'cursor-pointer pr-8', heightClass, textClass, className)}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        {...props}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
