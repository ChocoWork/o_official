import { useId } from 'react';
import type { CheckboxProps } from './types';

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

  return (
    <label
      htmlFor={checkboxId}
      data-ui-checkbox="true"
      data-ui-checkbox-size={size}
      data-ui-checkbox-check-style={checkStyle}
      data-ui-checkbox-shape={shape}
      data-ui-checkbox-disabled={disabled ? 'true' : 'false'}
      className={className}
    >
      <input
        id={checkboxId}
        type="checkbox"
        data-ui-checkbox-input="true"
        className={inputClassName}
        {...props}
      />
      <span data-ui-checkbox-label="true">
        {label}
      </span>
    </label>
  );
}
