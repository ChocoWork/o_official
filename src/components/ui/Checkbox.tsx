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
  expandLabelHitArea = false,
  ...props
}: CheckboxProps) {
  const generatedId = useId();
  const checkboxId = id ?? props.name ?? generatedId;
  const disabled = props.disabled ?? false;

  const rootProps = {
    'data-ui-checkbox': 'true',
    'data-ui-checkbox-size': size,
    'data-ui-checkbox-check-style': checkStyle,
    'data-ui-checkbox-shape': shape,
    'data-ui-checkbox-disabled': disabled ? 'true' : 'false',
    'data-ui-checkbox-expand-hit-area': expandLabelHitArea ? 'true' : 'false',
    className,
  };

  const checkboxInput = (
    <input
      id={checkboxId}
      type="checkbox"
      data-ui-checkbox-input="true"
      className={inputClassName}
      {...props}
    />
  );

  const checkboxLabel = expandLabelHitArea ? (
    <span data-ui-checkbox-label="true">
      {label}
    </span>
  ) : (
    <label htmlFor={checkboxId} data-ui-checkbox-label="true">
      {label}
    </label>
  );

  if (expandLabelHitArea) {
    return (
      <label
        htmlFor={checkboxId}
        {...rootProps}
      >
        {checkboxInput}
        {checkboxLabel}
      </label>
    );
  }

  return (
    <div
      {...rootProps}
    >
      {checkboxInput}
      {checkboxLabel}
    </div>
  );
}
