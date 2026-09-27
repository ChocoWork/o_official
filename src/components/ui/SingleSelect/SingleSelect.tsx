// File: src/components/ui/SingleSelect/SingleSelect.tsx
'use client';

import '@/components/ui/SingleSelect/SingleSelect.css';
import { cn } from '@/lib/utils';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import ReactDOM from 'react-dom';
import type { SingleSelectProps } from '@/components/ui/SingleSelect/SingleSelect_types';
import { Button } from '@/components/ui/Button/Button';
import { LiveMessage } from '@/components/ui/LiveMessage/LiveMessage';

/** PageUp / PageDown で移る項目数（APG の select-only combobox と同じ） */
const PAGE_SIZE = 10;

/** 空白区切りの id を、重複を除いて順に並べる */
function joinIds(...ids: Array<string | null | undefined>): string | undefined {
  const tokens = ids.flatMap((value) => (value ? value.split(/\s+/) : [])).filter(Boolean);
  return tokens.length > 0 ? Array.from(new Set(tokens)).join(' ') : undefined;
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
  shape = 'square',
  align = 'right',
  bordered = true,
  block = false,
  multiline = false,
  errorText,
  'data-testid': dataTestId,
  ...props
}: SingleSelectProps) {
  const generatedId = useId();
  // 見出しを for で結びつけるので、id も name も無いときは生成した id を使う（TextField と同じ）
  const selectId = id ?? props.name ?? generatedId;
  const labelId = `${selectId}-label`;
  const listboxId = `${selectId}-listbox`;
  const optionIdPrefix = `${selectId}-option-`;
  const errorId = `${selectId}-error`;
  const { 'aria-describedby': describedByProp, 'aria-invalid': invalidProp, ...restProps } = props;
  // 誤りの案内は説明として結び、誤りの状態にする（FREQ-379。TextField と同じ考え方）
  const describedBy = joinIds(describedByProp, errorText ? errorId : null);
  const invalid = errorText ? true : invalidProp;

  const requiredMarker = props.required ? (
    <span className="single-select__required" aria-hidden="true">
      *
    </span>
  ) : null;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // 一覧を開いている間、キーボードで指している項目（aria-activedescendant）。フォーカスは引き金に置いたまま
  const [activeIndex, setActiveIndex] = useState(-1);
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
  const selectedIndex = options.findIndex((option) => option.value === resolvedValue);

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
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, variant]);

  useLayoutEffect(() => {
    if (variant !== 'dropdown' || block) {
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
  }, [options, size, variant, block]);

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

  // キーボードで指している項目を、一覧の見える範囲に入れる
  useEffect(() => {
    if (!open || activeIndex < 0 || !dropdownPos) return;
    document.getElementById(`${optionIdPrefix}${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, dropdownPos, optionIdPrefix]);

  const rootDataAttrs = {
    'data-ui-single-select': 'true',
    'data-ui-single-select-size': size,
    'data-ui-single-select-shape': shape,
    'data-ui-single-select-align': align,
    'data-ui-single-select-bordered': bordered ? 'true' : 'false',
    'data-ui-single-select-block': block ? 'true' : undefined,
    'data-ui-single-select-multiline': multiline ? 'true' : undefined,
    'data-ui-single-select-invalid': errorText ? 'true' : undefined,
    'data-ui-size': size,
  } as const;

  // 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-376）。欄の誤りなので割り込まない polite
  const errorNode = (
    <LiveMessage as="span" id={errorId} politeness="polite" className="single-select__error">
      {errorText}
    </LiveMessage>
  );

  // --- inline：選択肢を左寄せで横に並べるトグル群 ---
  if (variant === 'inline') {
    return (
      <div
        {...rootDataAttrs}
        data-ui-single-select-variant="inline"
        data-testid={dataTestId}
        role="group"
        aria-label={props['aria-label']}
        className={cn('single-select', className)}
      >
        {label ? (
          <span className="single-select__label">
            {label}
            {requiredMarker}
          </span>
        ) : null}
        <div className="single-select__options">
          {options.map((option) => (
            <Button
              key={option.value}
              variant="text"
              shape="square"
              size={size}
              selected={resolvedValue === option.value}
              selectedTone="outline"
              /* 2文字までは正方形の枠、3文字以上は内容なりの長方形 */
              aspect={option.label.length <= 2 ? 'square' : 'auto'}
              disabled={disabled}
              onClick={() => onValueChange?.(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  // --- dropdown：APG の select-only combobox。一覧はポータルに描く（FREQ-379）---
  if (variant === 'dropdown') {
    const selectedLabel = resolvedValue
      ? options.find((opt) => opt.value === resolvedValue)?.label ?? resolvedValue
      : placeholder || '選択してください';
    const lastIndex = options.length - 1;
    const startIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const openListbox = (index: number) => {
      setActiveIndex(index);
      setOpen(true);
    };
    const closeListbox = () => {
      setOpen(false);
      setActiveIndex(-1);
    };
    const selectOption = (index: number) => {
      const option = options[index];
      if (option) {
        onValueChange?.(option.value);
      }
      closeListbox();
    };

    const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled || options.length === 0) {
        return;
      }

      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        openListbox(event.key === 'Home' ? 0 : lastIndex);
        return;
      }

      if (!open) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          openListbox(startIndex);
        }
        return;
      }

      const current = activeIndex >= 0 ? activeIndex : startIndex;
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setActiveIndex(Math.min(current + 1, lastIndex));
          return;
        case 'ArrowUp':
          event.preventDefault();
          if (event.altKey) {
            selectOption(current);
            return;
          }
          setActiveIndex(Math.max(current - 1, 0));
          return;
        case 'PageDown':
          event.preventDefault();
          setActiveIndex(Math.min(current + PAGE_SIZE, lastIndex));
          return;
        case 'PageUp':
          event.preventDefault();
          setActiveIndex(Math.max(current - PAGE_SIZE, 0));
          return;
        case 'Enter':
        case ' ':
          event.preventDefault();
          selectOption(current);
          return;
        case 'Escape':
          // 一覧だけを閉じる。外側のダイアログなどまで閉じないよう、ここで止める
          event.preventDefault();
          event.stopPropagation();
          closeListbox();
          return;
        case 'Tab':
          // 次の欄へ移る既定の動きは止めず、指している項目を選んで閉じる
          selectOption(current);
          return;
        default:
      }
    };

    return (
      <div className="single-select" data-ui-single-select-variant="dropdown" {...rootDataAttrs}>
        {label ? (
          <label id={labelId} className="single-select__label" htmlFor={selectId}>
            {label}
            {requiredMarker}
          </label>
        ) : null}
        <div className="single-select__wrapper" ref={wrapperRef}>
          <button
            type="button"
            role="combobox"
            className={cn('single-select__trigger', className)}
            ref={triggerRef}
            id={selectId}
            data-ui-single-select-bordered={bordered ? 'true' : 'false'}
            style={triggerMinWidth ? ({ '--ss-trigger-min-width': `${triggerMinWidth}px` } as React.CSSProperties) : undefined}
            data-ui-single-select-disabled={disabled ? 'true' : undefined}
            data-ui-single-select-placeholder={!resolvedValue ? 'true' : undefined}
            onClick={() => {
              if (disabled) {
                return;
              }
              if (open) {
                closeListbox();
              } else {
                openListbox(startIndex);
              }
            }}
            onKeyDown={handleTriggerKeyDown}
            // Space の押し上げでボタンの既定の押下が起きないようにする（押し下げで開閉を済ませている）
            onKeyUp={(event) => {
              if (event.key === ' ') {
                event.preventDefault();
              }
            }}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-activedescendant={open && activeIndex >= 0 ? `${optionIdPrefix}${activeIndex}` : undefined}
            aria-label={props['aria-label']}
            aria-required={props.required ? true : undefined}
            aria-invalid={invalid}
            aria-describedby={describedBy}
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
                  id={listboxId}
                  className="single-select__menu"
                  data-ui-single-select-size={size}
                  data-ui-single-select-shape={shape}
                  data-ui-size={size}
                  style={{
                    top: dropdownPos.top,
                    left: dropdownPos.left,
                    width: dropdownPos.width,
                  }}
                  role="listbox"
                  aria-labelledby={label ? labelId : undefined}
                  aria-label={label ? undefined : props['aria-label']}
                >
                  {options.map((option, index) => (
                    <div key={option.value} className="single-select__option-row">
                      <div
                        id={`${optionIdPrefix}${index}`}
                        className="single-select__option"
                        data-ui-single-select-selected={resolvedValue === option.value ? 'true' : undefined}
                        data-ui-single-select-active={index === activeIndex ? 'true' : undefined}
                        role="option"
                        // APG の select-only combobox と同じく、指している項目を選択中として示す
                        aria-selected={index === activeIndex}
                        // 押してもフォーカスを引き金に残す（キーボード操作を続けられるように）
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectOption(index)}
                      >
                        {option.label}
                      </div>
                      {option.onAction && option.actionLabel ? (
                        <button type="button" className="single-select__option-action"
                          aria-label={option.actionLabel}
                          onClick={(event) => { event.preventDefault(); event.stopPropagation(); option.onAction?.(); }}>
                          <i className="ri-delete-bin-line" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>,
                document.body,
              )
            : null}
        </div>
        {errorNode}
      </div>
    );
  }

  // --- native（既定）：ネイティブ select ---
  return (
    <div className="single-select" data-ui-single-select-variant="native" {...rootDataAttrs}>
      {label ? (
        <label className="single-select__label" htmlFor={selectId}>
          {label}
          {requiredMarker}
        </label>
      ) : null}
      <div className="single-select__wrapper">
        <select
          id={selectId}
          className={cn('single-select__native', className)}
          data-ui-single-select-bordered={bordered ? 'true' : 'false'}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          {...restProps}
          aria-invalid={invalid}
          aria-describedby={describedBy}
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
      {errorNode}
    </div>
  );
}
