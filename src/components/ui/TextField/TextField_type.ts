// File: src/components/ui/TextField/TextField_type.ts
import type { InputHTMLAttributes, ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UITextFieldShape = 'rounded' | 'square' | 'underline';

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helperText?: string;
  errorText?: string;
  leadingIcon?: ReactNode;
  /** 入力左端に置くテキスト（ラベル文言など）。WITH ICON の応用で、値は右寄せ表示になる */
  leadingText?: ReactNode;
  /** 入力右端に置く要素（表示切替ボタン等）。ポインタ操作可 */
  trailingIcon?: ReactNode;
  /** corner shape: rounded (default) / square / underline（下線のみ） */
  shape?: UITextFieldShape;
  /** デモ用の小中大サイズ */
  size?: ComponentSize;
}