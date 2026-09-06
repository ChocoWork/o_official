import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIBottomNavigationAppearance = 'filled' | 'minimal';

export interface BottomNavigationItem {
  key: string;
  label?: string;
  icon?: ReactNode;
  iconClass?: string;
  /** 指定するとボタンではなくリンクとして描画する。 */
  href?: string;
  /** 遷移先が無い項目。操作できない見た目で置く。 */
  disabled?: boolean;
}

export interface BottomNavigationProps {
  items: BottomNavigationItem[];
  activeKey: string;
  /** ボタン項目（href なし）を使う場合に必要。 */
  onChange?: (key: string) => void;
  fixed?: boolean;
  appearance?: UIBottomNavigationAppearance;
  className?: string;
  /** コンポーネントのサイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
}