// File: src/components/ui/TextField/TextField.tsx
import "@/components/ui/TextField/TextField.css";
import { useId } from "react";
import { clsx } from "clsx";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import type { TextFieldProps } from "@/components/ui/TextField/TextField_type";

export function TextField({
  label,
  helperText,
  errorText,
  leadingIcon,
  leadingText,
  trailingIcon,
  className,
  id,
  shape = "square",
  size = "md",
  ...props
}: TextFieldProps) {
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
    "data-ui-text-field": "true",
    "data-ui-text-field-shape": shape,
    "data-ui-text-field-size": size,
    "data-ui-text-field-invalid": errorText ? "true" : undefined,
    "data-ui-text-field-has-icon": leadingIcon ? "true" : undefined,
    "data-ui-text-field-has-leading-text": leadingText ? "true" : undefined,
    "data-ui-text-field-has-trailing": trailingIcon ? "true" : undefined,
    "data-ui-size": size,
  } as const;

  // 部品全体を label で包まない（FREQ-375）。包むと案内や右端のボタンの名前まで入力欄の名前に
  // 混ざり、ボタンも label の中の操作要素になる（MDN: label の中に操作要素を置かない）。
  // 見出しは for で結びつける。
  return (
    <div className="text-field" {...rootDataAttrs}>
      {label ? (
        <label className="text-field__label" htmlFor={fieldId}>
          {label}
          {props.required ? (
            <span className="text-field__required" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      <span className="text-field__control">
        {leadingIcon ? (
          <span className="text-field__icon" aria-hidden="true">
            {leadingIcon}
          </span>
        ) : null}
        {leadingText ? (
          // 欄の見出しの文言として使われるので、これも入力欄に結びつける（押すと入力欄へ移る）
          <label className="text-field__leading-text" htmlFor={fieldId}>
            {leadingText}
          </label>
        ) : null}
        <input
          id={fieldId}
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          className={clsx("text-field__input", className)}
          {...props}
        />
        {trailingIcon ? (
          <span className="text-field__trailing">{trailingIcon}</span>
        ) : null}
      </span>
      {/* 案内の入れ物は常に置き、中身だけを入れ替える（FREQ-375）。欄ごとの誤りは確定時に
          いくつも同時に出うるので、割り込まずに順番に読む polite にする（FREQ-376） */}
      <LiveMessage
        as="span"
        id={errorId}
        politeness="polite"
        className="text-field__error"
      >
        {errorText}
      </LiveMessage>
      {!errorText && helperText ? (
        <span id={helperId} className="text-field__helper">
          {helperText}
        </span>
      ) : null}
    </div>
  );
}
