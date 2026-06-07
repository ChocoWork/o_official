// File: src/components/ui/Dropdown/Dropdown_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIDropdownAlign = 'left' | 'right';

export interface DropdownItem {
  key: string;
  label: string;
  iconClass?: string;
  hasDividerBefore?: boolean;
  onSelect: () => void;
}

export interface DropdownProps {
  /** トリガーの中身。テキストでも任意の React 要素（アイコン等）でも可 */
  triggerLabel: ReactNode;
  items: DropdownItem[];
  className?: string;
  /** サイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
  /** true のとき hover で開く（既定は click） */
  openOnHover?: boolean;
  /** トリガーに対するメニューの揃え。left（既定）/ right */
  align?: UIDropdownAlign;
}