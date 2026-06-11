// File: src/components/ui/TextField/TextField.tsx
import "@/components/ui/TextField/TextField.css";
import { cn } from "@/lib/utils";
import type { TextFieldProps } from "@/components/ui/TextField/TextField_type";

export function TextField({
  label,
  helperText,
  errorText,
  leadingIcon,
  className,
  id,
  shape = "square",
  size = "md",
  ...props
}: TextFieldProps) {
  const fieldId = id ?? props.name;
  const errorId = fieldId ? `${fieldId}-error` : undefined;
  const helperId = fieldId ? `${fieldId}-helper` : undefined;

  const describedBy =
    [
      errorText && errorId ? errorId : null,
      !errorText && helperText && helperId ? helperId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const rootDataAttrs = {
    "data-ui-text-field": "true",
    "data-ui-text-field-shape": shape,
    "data-ui-text-field-size": size,
    "data-ui-text-field-invalid": errorText ? "true" : undefined,
    "data-ui-text-field-has-icon": leadingIcon ? "true" : undefined,
    "data-ui-size": size,
  } as const;

  return (
    <label className="text-field" {...rootDataAttrs}>
      {label ? <span className="text-field__label">{label}</span> : null}
      <span className="text-field__control">
        {leadingIcon ? (
          <span className="text-field__icon" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : null}
        <input
          id={fieldId}
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          className={cn("text-field__input", className)}
          {...props}
        />
      </span>
      {errorText ? (
        <span id={errorId} role="alert" className="text-field__error">
          {errorText}
        </span>
      ) : null}
      {!errorText && helperText ? (
        <span id={helperId} className="text-field__helper">
          {helperText}
        </span>
      ) : null}
    </label>
  );
}
