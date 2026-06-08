// File: src/components/ui/TextAreaField/TextAreaField.tsx
import "@/components/ui/TextAreaField/TextAreaField.css";
import { cn } from "@/lib/utils";
import type { TextAreaFieldProps } from "@/components/ui/TextAreaField/TextAreaField_type";

export function TextAreaField({
  label,
  helperText,
  errorText,
  className,
  id,
  rows = 4,
  shape = "rounded",
  size = "md",
  ...props
}: TextAreaFieldProps) {
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
    "data-ui-text-area-field": "true",
    "data-ui-text-area-field-shape": shape,
    "data-ui-text-area-field-size": size,
    "data-ui-text-area-field-invalid": errorText ? "true" : undefined,
  } as const;

  return (
    <label className="text-area-field" {...rootDataAttrs}>
      {label ? <span className="text-area-field__label">{label}</span> : null}
      <textarea
        id={fieldId}
        rows={rows}
        aria-describedby={describedBy}
        aria-invalid={errorText ? true : undefined}
        className={cn("text-area-field__input", className)}
        {...props}
      />
      {errorText ? (
        <span id={errorId} role="alert" className="text-area-field__error">
          {errorText}
        </span>
      ) : null}
      {!errorText && helperText ? (
        <span id={helperId} className="text-area-field__helper">
          {helperText}
        </span>
      ) : null}
    </label>
  );
}
