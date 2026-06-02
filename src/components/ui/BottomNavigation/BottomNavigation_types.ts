import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIBottomNavigationAppearance = 'filled' | 'minimal';

export interface BottomNavigationItem {
  key: string;
  label?: string;
  icon?: ReactNode;
  iconClass?: string;
}

export interface BottomNavigationProps {
  items: BottomNavigationItem[];
  activeKey: string;
  onChange: (key: string) => void;
  fixed?: boolean;
  appearance?: UIBottomNavigationAppearance;
  className?: string;
  /** コンポーネントのサイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
}