// File: src/components/ui/Toolbar/Toolbar_type.ts
import type { MouseEventHandler, ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIToolbarVariant = 'default' | 'muted';

export interface ToolbarItem {
  key: string;
  iconClass: string;
  label?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

export interface ToolbarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  leftItems?: readonly ToolbarItem[];
  rightItems?: readonly ToolbarItem[];
  /** leftItems のうち、この index の直前に区切り線を挿入する */
  splitIndex?: number;
  /** 背景トーン。default（白）/ muted（subtle 背景） */
  variant?: UIToolbarVariant;
  className?: string;
  /** サイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
}