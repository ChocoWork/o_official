// File: src/components/ui/SingleSelect/SingleSelect_types.ts
import type { SelectHTMLAttributes } from 'react';
import type { ComponentSize, SelectOption } from '@/components/ui/types';

export type UISingleSelectVariant = 'native' | 'dropdown';
export type UISingleSelectSize = ComponentSize | 'compact';
export type UISingleSelectShape = 'square' | 'rounded';
export type UISingleSelectAlign = 'left' | 'right';

export interface SingleSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  options: SelectOption[];
  placeholder?: string;
  variant?: UISingleSelectVariant;
  onValueChange?: (value: string) => void;
  /** demo-friendly size: compact/xs/sm/md/lg/xl default md */
  size?: UISingleSelectSize;
  /** 角の形状。square（既定）/ rounded */
  shape?: UISingleSelectShape;
  /** dropdown: トリガー内の選択値の揃え。right（既定：シェブロン寄せ）/ left（左寄せ・シェブロンは右端） */
  align?: UISingleSelectAlign;
  bordered?: boolean;
  /** dropdown: トリガーを全幅にしテキスト左・シェブロン右で配置（フォーム用）。既定 false（コンパクト右寄せ）*/
  block?: boolean;
  /** dropdown: 選択値ラベルの改行(\n)を複数行表示する（住所の2行表示など）。既定 false */
  multiline?: boolean;
}