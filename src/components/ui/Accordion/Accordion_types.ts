import { ReactNode } from 'react';
import { ComponentSize } from '@/components/ui/types';

export interface AccordionItem {
  key: string;
  /** Title can be a string or React element; commonly used for radio + label layout */
  title: ReactNode;
  content: ReactNode;
  className?: string;
}

export interface AccordionProps {
  items: readonly AccordionItem[];
  openKey?: string | null;
  onOpenChange?: (key: string | null) => void;
  defaultOpenKeys?: readonly string[];
  className?: string;
  itemClassName?: string;
  triggerClassName?: string;
  contentClassName?: string;
  /** demo-compatible size modifier */
  size?: ComponentSize;
  /** controls hover surface color and the item spacing that supports it */
  highlightOnHover?: boolean;
  /** controls whether trigger rows render an underline */
  showUnderline?: boolean;
  /** controls whether each item renders a top border line instead of bottom underline */
  showTopline?: boolean;
  /** #sym:size: single keeps current behavior, multiple allows opening multiple items */
  openMode?: 'single' | 'multiple';
}