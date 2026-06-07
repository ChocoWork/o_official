// File: src/components/ui/Tooptip/Tooptip_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UITooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** 表示位置。top（既定）/ bottom / left / right */
  placement?: UITooltipPlacement;
  /** ツールチップのサイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
}