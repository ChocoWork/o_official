// File: src/components/ui/Drawer/Drawer_types.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIDrawerSide = 'left' | 'right';
export type UIDrawerShape = 'rounded' | 'square';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** slide-in side: right (default) / left */
  side?: UIDrawerSide;
  children: ReactNode;
  className?: string;
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
  /** 角の形状。square（既定）/ rounded */
  shape?: UIDrawerShape;
}