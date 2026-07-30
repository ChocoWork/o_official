import type { ComponentSize } from '@/components/ui/types';

export interface PageControlProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
  size?: ComponentSize;
  /**
   * 表示する数字ボタンの上限。総ページ数がこれを超えると
   * 先頭側／末尾側だけを残し、間を「…」で畳む。省略時は全ページを出す。
   */
  maxVisiblePages?: number;
}
