import { Checkbox } from './Checkbox';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import type { SelectOption } from './shared';
import { ComponentSize } from './types';

export interface MultiSelectProps {
  options: SelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  label?: string;
  placeholder?: string;
  variant?: 'panel' | 'dropdown' | 'buttons'; // button-style toggle group
  size?: ComponentSize;
  /** 'check' = native checkbox (default), 'fill' = solid black square */
  checkStyle?: 'check' | 'fill';
  shape?: 'square' | 'rounded';
  className?: string;
}

export function MultiSelect({
  options,
  values,
  onChange,
  label,
  placeholder = '選択してください',
  variant = 'panel',
  size = 'md',
  checkStyle = 'check',
  shape = 'rounded',
  className,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const handleChange = (optionValue: string) => {
    if (values.includes(optionValue)) {
      onChange(values.filter((value) => value !== optionValue));
      return;
    }
    onChange([...values, optionValue]);
  };

  const renderOptionItem = (option: SelectOption) => {
    const isChecked = values.includes(option.value);
    const shapeClass = shape === 'square' ? 'rounded-none' : 'rounded';

    return (
      <Checkbox
        key={option.value}
        label={option.label}
        checked={isChecked}
        onChange={() => handleChange(option.value)}
        size={size}
        checkStyle={checkStyle}
        shape={shape}
        className={cn(
          'w-full justify-start px-3 py-1.5 transition-colors hover:bg-[#f5f5f5]',
          'text-[#474747] tracking-widest',
        )}
        inputClassName={cn(
          checkStyle === 'fill' ? 'h-2.5 w-2.5' : 'h-4 w-4',
          shapeClass,
        )}
      />
    );
  };

  useEffect(() => {
    if (variant !== 'dropdown' || !open) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, variant]);

  // size-specific helpers using explicit maps
  const buttonTextSizeMap: Record<ComponentSize, string> = {
    xs: 'text-[10px]',
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
    xl: 'text-lg',
  };
  const buttonPadMap: Record<ComponentSize, string> = {
    xs: 'px-3 py-1',
    sm: 'px-4 py-1',
    md: 'px-6 py-2',
    lg: 'px-8 py-3',
    xl: 'px-10 py-4',
  };
  // Dropdown trigger: min-h (not fixed) so multi-line selections expand naturally
  const dropdownTriggerMinHMap: Record<ComponentSize, string> = {
    xs: 'min-h-7 py-1',
    sm: 'min-h-8 py-1.5',
    md: 'min-h-10 py-2',
    lg: 'min-h-12 py-3',
    xl: 'min-h-14 py-3.5',
  };
  // Dropdown trigger text: one step smaller than body text so long selections don't wrap as readily
  const dropdownTriggerTextMap: Record<ComponentSize, string> = {
    xs: 'text-[10px]',
    sm: 'text-[11px]',
    md: 'text-sm',
    lg: 'text-base',
    xl: 'text-lg',
  };
  const buttonTextSize = buttonTextSizeMap[size];
  const buttonPad = buttonPadMap[size];

  if (variant === 'buttons') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef}>
        {label ? <span className="block text-xs tracking-widest text-black/80">{label}</span> : null}
        <div className="flex gap-3 flex-wrap">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleChange(option.value)}
              className={cn(
                buttonPad,
                buttonTextSize,
                'tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border',
                values.includes(option.value)
                  ? 'border-black bg-black text-white'
                  : 'border-black text-black hover:bg-black hover:text-white',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'panel') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef}>
        {label ? <span className="block text-xs tracking-widest text-black/80">{label}</span> : null}
        <div className="space-y-2">
          {options.map((option) => renderOptionItem(option))}
        </div>
      </div>
    );
  }

  if (variant === 'dropdown') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef}>
        {label ? <span className="block text-xs tracking-widest text-black/80">{label}</span> : null}
        <div className="relative">
          <button
            type="button"
            className={cn(
              'w-full cursor-pointer border border-black/20 text-left focus:border-black focus:outline-none transition-colors flex items-center justify-between',
              dropdownTriggerMinHMap[size],
              dropdownTriggerTextMap[size],
              'px-4',
            )}
            onClick={() => setOpen((previous) => !previous)}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span>{values.length > 0 ? values.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : placeholder}</span>
            <span className="flex h-4 w-4 items-center justify-center">
              <i className={cn('text-base transition-transform', open ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line')}></i>
            </span>
          </button>
          {open ? (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 border border-black/20 bg-white shadow-lg">
              {options.map((option) => renderOptionItem(option))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
