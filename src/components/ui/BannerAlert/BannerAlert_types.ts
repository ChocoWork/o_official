import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIBannerAlertVariant = 'info' | 'warning' | 'error' | 'success';

export type UIBannerAlertShape = 'rounded' | 'square';

export interface BannerAlertProps {
  title?: string;
  message?: string;
  description?: string;
  variant?: UIBannerAlertVariant;
  /** corner shape: rounded (default) / square */
  shape?: UIBannerAlertShape;
  icon?: ReactNode;
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
}