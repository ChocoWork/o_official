import type { ComponentSize } from '@/components/ui/types';

export type UIActionSheetShape = 'rounded' | 'square';

export interface ActionSheetAction {
  key: string;
  label: string;
  iconClass?: string;
  destructive?: boolean;
  onSelect: () => void;
}

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  actions: ActionSheetAction[];
  size?: ComponentSize;
  shape?: UIActionSheetShape;
  cancelLabel?: string;
  className?: string;
}