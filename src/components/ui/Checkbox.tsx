import { cn } from '@/lib/utils';
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { ComponentSize } from './types';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className'> {
  label: ReactNode;
  size?: ComponentSize;
  checkStyle?: 'check' | 'fill';
  shape?: 'square' | 'rounded';
  className?: string;
  inputClassName?: string;
}

export function Checkbox({
  label,
  className,
  inputClassName,
  id,
  size = 'md',
  checkStyle = 'check',
  shape = 'rounded',
  ...props
}: CheckboxProps) {
  const generatedId = useId();
  const checkboxId = id ?? props.name ?? generatedId;
  const disabled = props.disabled ?? false;

  const labelSizeMap: Record<ComponentSize, string> = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };
  const shapeClass = shape === 'square' ? 'rounded-none' : 'rounded';
  const inputClass = cn(
    'flex-shrink-0 cursor-pointer transition-colors',
    shapeClass,
    checkStyle === 'fill'
      ? 'h-4 w-4 border border-black/40 bg-white appearance-none outline-none checked:border-black checked:bg-black checked:ring-0'
      : 'h-4 w-4 border border-black/20 accent-black',
    inputClassName,
  );

  return (
    <label
      htmlFor={checkboxId}
      data-ui-checkbox="true"
      data-ui-checkbox-size={size}
      data-ui-checkbox-check-style={checkStyle}
      data-ui-checkbox-disabled={disabled ? 'true' : 'false'}
      className={cn(
        'flex cursor-pointer items-center gap-2',
        disabled ? 'cursor-not-allowed opacity-50' : 'group',
        className,
      )}
    >
      <span className={cn(labelSizeMap[size], 'text-[#474747] tracking-widest')}>
        {label}
      </span>
      <input
        id={checkboxId}
        type="checkbox"
        data-ui-checkbox-input="true"
        className={inputClass}
        {...props}
      />
    </label>
  );
}
