import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface MapViewProps {
  title?: string;
  children?: ReactNode;
  embedUrl?: string;
  showTitle?: boolean;
  className?: string;
  embedWrapperClassName?: string;
  iframeClassName?: string;
  size?: ComponentSize;
}
