import type { ComponentSize } from '@/components/ui/types';

export interface SwitchToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  ariaLabel?: string;
  /** 理由や注意の文の id。切り替えのボタンの aria-describedby に結ぶ（読み上げで一緒に伝わる） */
  ariaDescribedBy?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  size?: ComponentSize;
}
