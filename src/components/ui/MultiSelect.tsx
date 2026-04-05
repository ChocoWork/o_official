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
  /** dropdown variant only: 'check' = native checkbox (default), 'fill' = solid black square */
  checkStyle?: 'check' | 'fill';
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
  const textClassMap: Record<ComponentSize, string> = {
    sm: 'text-sm',
    md: 'text-sm',
    lg: 'text-base',
  };
  const buttonTextSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };
  const buttonPadMap: Record<ComponentSize, string> = {
    sm: 'px-4 py-1',
    md: 'px-6 py-2',
    lg: 'px-8 py-3',
  };
  // Dropdown trigger: min-h (not fixed) so multi-line selections expand naturally
  const dropdownTriggerMinHMap: Record<ComponentSize, string> = {
    sm: 'min-h-8 py-1.5',
    md: 'min-h-10 py-2',
    lg: 'min-h-12 py-3',
  };
  // Dropdown trigger text: one step smaller than body text so long selections don't wrap as readily
  const dropdownTriggerTextMap: Record<ComponentSize, string> = {
    sm: 'text-[11px]',
    md: 'text-sm',
    lg: 'text-base',
  };
  const textClass = textClassMap[size];
  const buttonTextSize = buttonTextSizeMap[size];
  const buttonPad = buttonPadMap[size];

  if (variant === 'buttons') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
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

  if (variant === 'dropdown') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
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
            <span>{values.length > 0 ? values.join(', ') : placeholder}</span>
            <span className="flex h-4 w-4 items-center justify-center">
              <i className={cn('text-base transition-transform', open ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line')}></i>
            </span>
          </button>
          {open ? (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 border border-black/20 bg-white shadow-lg">
              {options.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-[#f5f5f5]"
                >
                  {checkStyle === 'fill' ? (
                    <>
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-2.5 w-2.5 flex-shrink-0 border',
                          values.includes(option.value)
                            ? 'bg-black border-black'
                            : 'bg-white border-black/40',
                        )}
                      />
                      <input
                        className="sr-only"
                        type="checkbox"
                        checked={values.includes(option.value)}
                        onChange={() => handleChange(option.value)}
                      />
                    </>
                  ) : (
                    <input
                      className="h-4 w-4 cursor-pointer accent-black"
                      type="checkbox"
                      checked={values.includes(option.value)}
                      onChange={() => handleChange(option.value)}
                    />
                  )}
                  <span className="text-xs text-black">{option.label}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <fieldset className="space-y-2">
      {label ? <legend className="text-xs tracking-widest text-black/80 font-brand">{label}</legend> : null}
      <div className="space-y-2 border border-black/20 p-3">
        {options.map((option) => (
          <Checkbox
            key={option.value}
            name={option.value}
            checked={values.includes(option.value)}
            onChange={() => handleChange(option.value)}
            label={option.label}
            size={size}
          />
        ))}
      </div>
    </fieldset>
  );
}
