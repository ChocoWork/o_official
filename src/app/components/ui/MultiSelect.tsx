import { Checkbox } from './Checkbox';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import type { SelectOption } from './shared';

export interface MultiSelectProps {
  options: SelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  label?: string;
  placeholder?: string;
  variant?: 'panel' | 'dropdown';
  className?: string;
}

export function MultiSelect({
  options,
  values,
  onChange,
  label,
  placeholder = '選択してください',
  variant = 'panel',
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

  if (variant === 'dropdown') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef}>
        {label ? <span className="block text-xs tracking-widest text-black/80 font-brand">{label}</span> : null}
        <div className="relative">
          <button
            type="button"
            className="w-full cursor-pointer border border-black/20 px-4 py-3 text-left text-sm focus:border-black focus:outline-none transition-colors flex items-center justify-between"
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
                  className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-[#f5f5f5]"
                >
                  <input
                    className="h-4 w-4 cursor-pointer accent-black"
                    type="checkbox"
                    checked={values.includes(option.value)}
                    onChange={() => handleChange(option.value)}
                  />
                  <span className="text-sm text-black">{option.label}</span>
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
          />
        ))}
      </div>
    </fieldset>
  );
}
