// File: src/components/ui/Card/Card_types.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface CardProps {
  children?: ReactNode;
  className?: string;
  /** hover でボーダーを強調する（children モード時） */
  hoverable?: boolean;
  image?: ReactNode;
  imageClassName?: string;
  overlayAction?: ReactNode;
  category?: string;
  title?: string;
  price?: string;
  footer?: ReactNode;
  /** optional label shown above content (e.g. for upload form) */
  label?: string;
  /** multiple preview images with removable icons (for upload UI) */
  previewUrls?: string[];
  onRemovePreview?: (index: number) => void;
  /** card size controlling padding/text. xs/sm/md/lg/xl default md */
  size?: ComponentSize;
}