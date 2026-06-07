// File: src/components/ui/TextField/TextField_type.ts
import type { InputHTMLAttributes, ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UITextFieldShape = 'rounded' | 'square';

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helperText?: string;
  errorText?: string;
  leadingIcon?: ReactNode;
  /** corner shape: rounded (default) / square */
  shape?: UITextFieldShape;
  /** デモ用の小中大サイズ */
  size?: ComponentSize;
}