// File: src/components/ui/TextAreaField/TextAreaField.tsx
import "@/components/ui/TextAreaField/TextAreaField.css";
import { useId } from "react";
import { clsx } from "clsx";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import type { TextAreaFieldProps } from "@/components/ui/TextAreaField/TextAreaField_type";

export function TextAreaField({
  label,
  helperText,
  errorText,
  className,
  id,
  rows = 4,
  shape = "square",
  size = "md",
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  // 見出しを for で結びつけるので、id も name も無いときは生成した id を使う
  const fieldId = id ?? props.name ?? generatedId;
  const errorId = `${fieldId}-error`;
  const helperId = `${fieldId}-helper`;

  const describedBy =
    [errorText ? errorId : null, !errorText && helperText ? helperId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const rootDataAttrs = {
    "data-ui-text-area-field": "true",
    "data-ui-text-area-field-shape": shape,
    "data-ui-text-area-field-size": size,
    "data-ui-text-area-field-invalid": errorText ? "true" : undefined,
    "data-ui-size": size,
  } as const;

  // TextField と同じく部品全体を label で包まない（FREQ-376）。包むと案内や補足文まで入力欄の名前に
  // 混ざる。見出しは for で結びつける。
  return (
    <div className="text-area-field" {...rootDataAttrs}>
      {label ? (
        <label className="text-area-field__label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <textarea
        id={fieldId}
        rows={rows}
        aria-describedby={describedBy}
        aria-invalid={errorText ? true : undefined}
        className={clsx("text-area-field__input", className)}
        {...props}
      />
      {/* 案内の入れ物は常に置き、中身だけを入れ替える。欄ごとの誤りは割り込まずに順番に読む */}
      <LiveMessage
        as="span"
        id={errorId}
        politeness="polite"
        className="text-area-field__error"
      >
        {errorText}
      </LiveMessage>
      {!errorText && helperText ? (
        <span id={helperId} className="text-area-field__helper">
          {helperText}
        </span>
      ) : null}
    </div>
  );
}
