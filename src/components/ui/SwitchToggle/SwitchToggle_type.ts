import type { ComponentSize } from '@/components/ui/types';

export interface SwitchToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  size?: ComponentSize;
}
