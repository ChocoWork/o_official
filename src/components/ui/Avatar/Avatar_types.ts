import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIAvatarStatus = 'online' | 'offline';

export interface AvatarProps {
  src?: string;
  alt: string;
  fallback: string;
  size?: ComponentSize;
  icon?: ReactNode;
  className?: string;
  status?: UIAvatarStatus;
}