// File: src/components/ui/Tooptip/Tooptip_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UITooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export type UITooltipShape = 'square' | 'rounded';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** 表示位置。top（既定）/ bottom / left / right */
  placement?: UITooltipPlacement;
  /** 角の形状。square（既定）/ rounded */
  shape?: UITooltipShape;
  /** ツールチップのサイズ。xs/sm/md/lg/xl。デフォルトは 'md'。 */
  size?: ComponentSize;
}