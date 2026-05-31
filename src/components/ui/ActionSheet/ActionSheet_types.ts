import { ComponentSize } from '@/components/ui/types';

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
}