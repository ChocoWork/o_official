import "@/components/ui/MultiSelect/MultiSelect.css";
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import type { MultiSelectProps} from '@/components/ui/MultiSelect/MultiSelect_types';
import type { SelectOption } from '@/components/ui/types';

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
  expandLabelHitArea = false,
  renderOptionLabel,
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
    const optionLabel = renderOptionLabel ? renderOptionLabel(option, isChecked) : option.label;

    return (
      <Checkbox
        key={option.value}
        label={optionLabel}
        checked={isChecked}
        onChange={() => handleChange(option.value)}
        size={size}
        checkStyle={checkStyle}
        shape={shape}
        expandLabelHitArea={expandLabelHitArea}
        className={cn(
          'w-full justify-start px-3 transition-colors',
          expandLabelHitArea ? 'py-1.5 hover:bg-[#f5f5f5]' : 'py-[3px]',
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

  if (variant === 'buttons') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef} data-ui-multiselect="true" data-ui-multiselect-variant={variant}>
        {label ? <span className="block text-xs tracking-widest text-black/80">{label}</span> : null}
        <div className="flex gap-3 flex-wrap">
          {options.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={values.includes(option.value) ? 'primary' : 'secondary'}
              size={size}
              shape={shape}
              onClick={() => handleChange(option.value)}
              aria-pressed={values.includes(option.value)}
              className={cn(
                'tracking-widest whitespace-nowrap',
              )}
            >
              {renderOptionLabel ? renderOptionLabel(option, values.includes(option.value)) : option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  if (variant === 'panel') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef} data-ui-multiselect="true" data-ui-multiselect-variant={variant}>
        {label ? <span className="block text-xs tracking-widest text-black/80">{label}</span> : null}
        <div className="space-y-2">
          {options.map((option) => renderOptionItem(option))}
        </div>
      </div>
    );
  }

  if (variant === 'dropdown') {
    return (
      <div className={cn('space-y-2', className)} ref={wrapperRef} data-ui-multiselect="true" data-ui-multiselect-variant={variant}>
        {label ? <span className="block text-xs tracking-widest text-black/80">{label}</span> : null}
        <div className="relative">
          <button
            type="button"
            data-ui-multiselect-trigger="true"
            data-ui-multiselect-size={size}
            data-ui-size={size}
            onClick={() => setOpen((previous) => !previous)}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span data-ui-multiselect-trigger-label="true">{values.length > 0 ? values.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : placeholder}</span>
            <span data-ui-multiselect-trigger-icon="true">
              <i className={open ? 'ri-arrow-up-s-line' : 'ri-arrow-down-s-line'}></i>
            </span>
          </button>
          {open ? (
            <div className="absolute left-0 right-0 top-full z-10 mt-1" data-ui-multiselect-panel="true">
              {options.map((option) => renderOptionItem(option))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
