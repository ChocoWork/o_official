// File: src/components/ui/TextAreaField/TextAreaField_type.ts
import type { TextareaHTMLAttributes } from "react";
import type { ComponentSize } from "@/components/ui/types";

export type UITextAreaFieldShape = "rounded" | "square";

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "size"
> {
  label?: string;
  helperText?: string;
  errorText?: string;
  /** corner shape: rounded (default) / square */
  shape?: UITextAreaFieldShape;
  /** sm/md/lg を受け取り、行数を調整 */
  size?: ComponentSize;
}
