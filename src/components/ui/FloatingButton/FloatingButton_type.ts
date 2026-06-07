// File: src/components/ui/FloatingButton/FloatingButton_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface FloatingButtonAction {
  key: string;
  iconClass: string;
  onClick: () => void;
}

export interface FloatingButtonProps {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  actions?: FloatingButtonAction[];
  /** アクション展開状態（制御コンポーネント）*/
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** true で画面右下に固定配置（既定）*/
  fixed?: boolean;
  className?: string;
  /** サイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
}