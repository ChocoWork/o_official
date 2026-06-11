// File: src/components/ui/SingleSelect/SingleSelect.tsx
'use client';

import '@/components/ui/SingleSelect/SingleSelect.css';
import { cn } from '@/lib/utils';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { SingleSelectProps } from '@/components/ui/SingleSelect/SingleSelect_types';

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
  bordered = true,
  ...props
}: SingleSelectProps) {
  const selectId = id ?? props.name;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [triggerMinWidth, setTriggerMinWidth] = useState<number | null>(null);
  const [dropdownPos, setDropdownPos] = useState<
    { top: number; left: number; width: number } | null
  >(null);

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

  useLayoutEffect(() => {
    if (variant !== 'dropdown') {
      setTriggerMinWidth(null);
      return;
    }

    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    let cancelled = false;

    const measure = () => {
      const buttonStyle = getComputedStyle(trigger);
      const chevron = trigger.querySelector('.single-select__chevron');
      const chevronWidth = chevron instanceof HTMLElement ? chevron.getBoundingClientRect().width : 0;
      const textCanvas = document.createElement('canvas');
      const context = textCanvas.getContext('2d');
      if (!context) {
        return;
      }

      context.font = [
        buttonStyle.fontStyle,
        buttonStyle.fontVariant,
        buttonStyle.fontWeight,
        buttonStyle.fontSize,
        buttonStyle.fontFamily,
      ]
        .filter(Boolean)
        .join(' ');

      const widestLabelWidth = Math.max(
        ...options.map((option) => context.measureText(option.label).width),
      );
      const horizontalPadding =
        Number.parseFloat(buttonStyle.paddingLeft) + Number.parseFloat(buttonStyle.paddingRight);
      const borderWidth =
        Number.parseFloat(buttonStyle.borderLeftWidth) + Number.parseFloat(buttonStyle.borderRightWidth);
      const gapWidth = Number.parseFloat(buttonStyle.columnGap || '0');

      const nextWidth = Math.ceil(widestLabelWidth + chevronWidth + gapWidth + horizontalPadding + borderWidth);
      if (!cancelled) {
        setTriggerMinWidth(nextWidth);
      }
    };

    const ready = document.fonts?.ready;
    if (ready) {
      ready.then(measure).catch(() => {
        measure();
      });
    } else {
      measure();
    }

    return () => {
      cancelled = true;
    };
  }, [options, size, variant]);

  // reposition dropdown when it opens
  useEffect(() => {
    if (variant === 'dropdown' && open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
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
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
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

  const rootDataAttrs = {
    'data-ui-single-select': 'true',
    'data-ui-single-select-size': size,
    'data-ui-single-select-bordered': bordered ? 'true' : 'false',
    'data-ui-size': size,
  } as const;

  // --- dropdown：ポータル描画のカスタムリスト ---
  if (variant === 'dropdown') {
    const selectedLabel = resolvedValue
      ? options.find((opt) => opt.value === resolvedValue)?.label ?? resolvedValue
      : placeholder || '選択してください';

    return (
      <label className="single-select" data-ui-single-select-variant="dropdown" {...rootDataAttrs}>
        {label ? <span className="single-select__label">{label}</span> : null}
        <div className="single-select__wrapper" ref={wrapperRef}>
          <button
            type="button"
            className={cn('single-select__trigger', className)}
            ref={triggerRef}
            data-ui-single-select-bordered={bordered ? 'true' : 'false'}
            style={triggerMinWidth ? ({ '--ss-trigger-min-width': `${triggerMinWidth}px` } as React.CSSProperties) : undefined}
            data-ui-single-select-disabled={disabled ? 'true' : undefined}
            data-ui-single-select-placeholder={!resolvedValue ? 'true' : undefined}
            onClick={() => {
              if (!disabled) {
                setOpen((previous) => !previous);
              }
            }}
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={disabled}
          >
            <span className="single-select__value">{selectedLabel}</span>
            <span className="single-select__chevron" data-ui-single-select-open={open ? 'true' : undefined}>
              <i className="ri-arrow-down-s-line" aria-hidden="true" />
            </span>
          </button>

          {open && dropdownPos
            ? ReactDOM.createPortal(
                <div
                  ref={dropdownRef}
                  className="single-select__menu"
                  data-ui-single-select-size={size}
                  data-ui-size={size}
                  style={{
                    top: dropdownPos.top,
                    left: dropdownPos.left,
                    width: dropdownPos.width,
                  }}
                  role="listbox"
                >
                  {options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="single-select__option"
                      data-ui-single-select-selected={
                        resolvedValue === option.value ? 'true' : undefined
                      }
                      role="option"
                      aria-selected={resolvedValue === option.value}
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
              )
            : null}
        </div>
      </label>
    );
  }

  // --- native（既定）：ネイティブ select ---
  return (
    <label className="single-select" data-ui-single-select-variant="native" {...rootDataAttrs}>
      {label ? <span className="single-select__label">{label}</span> : null}
      <div className="single-select__wrapper">
        <select
          id={selectId}
          className={cn('single-select__native', className)}
          data-ui-single-select-bordered={bordered ? 'true' : 'false'}
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
        <span className="single-select__chevron single-select__chevron--native" aria-hidden="true">
          <i className="ri-arrow-down-s-line" />
        </span>
      </div>
    </label>
  );
}