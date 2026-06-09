import "./RadioButtonGroup.css";
import type { RadioButtonGroupProps } from "./RadioButtonGroup_type";

export type { RadioOption, RadioButtonGroupProps } from "./RadioButtonGroup_type";

export function RadioButtonGroup({
  name,
  value,
  options,
  onChange,
  direction = 'column',
  variant = 'simple',
  size = 'md',
  label,
  className,
}: RadioButtonGroupProps) {
  return (
    <label
      data-ui-radio-group=""
      data-ui-size={size}
      data-ui-radio-direction={direction}
      className={className}
    >
      {label && (
        <span data-ui-radio-group-label="">{label}</span>
      )}
      <div data-ui-radio-items="">
        {options.map((option) => (
          <label
            key={option.value}
            data-ui-radio-item=""
            data-ui-radio-variant={variant}
            data-ui-radio-disabled={option.disabled ? "true" : undefined}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              disabled={option.disabled}
              data-ui-radio-input=""
            />
            <span data-ui-radio-item-label="">{option.label}</span>
            {option.description && (
              <span data-ui-radio-item-desc="">{option.description}</span>
            )}
          </label>
        ))}
      </div>
    </label>
  );
}
