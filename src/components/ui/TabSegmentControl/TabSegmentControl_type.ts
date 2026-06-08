import type { CSSProperties } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type TabSegmentVariant = 'segment' | 'tabs' | 'segment-pill' | 'tabs-standard';
export type TabSegmentOrientation = 'horizontal' | 'vertical';

export interface TabSegmentControlItem {
  key: string;
  label: string;
}

export interface TabSegmentControlProps {
  items: TabSegmentControlItem[];
  activeKey: string;
  onChange: (key: string) => void;
  variant?: TabSegmentVariant;
  className?: string;
  size?: ComponentSize;
  orientation?: TabSegmentOrientation;
  itemStyle?: CSSProperties;
}
