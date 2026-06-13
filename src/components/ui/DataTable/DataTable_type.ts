// File: src/components/ui/DataTable/DataTable_type.ts
import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export interface TableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** 列共通（header/cell 両方）に付与する追加クラス */
  className?: string;
  /** ヘッダーセルのみに付与する追加クラス */
  headerClassName?: string;
  /** ボディセルのみに付与する追加クラス */
  cellClassName?: string;
  /** セル内テキストの寄せ（整列）。既定は left */
  align?: 'left' | 'center' | 'right';
}

export type UIDataTableShape = 'square' | 'rounded';

export interface DataTableProps<T> {
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  emptyLabel?: string;
  containerClassName?: string;
  tableClassName?: string;
  headerClassName?: string;
  rowClassName?: string | ((row: T, index: number) => string);
  /** ホバー時に行へ面を出す（対比） */
  hoverableRows?: boolean;
  /** 偶数行に薄い面を敷く（反復／可読性） */
  striped?: boolean;
  /** 角の形状。square（既定）/ rounded */
  shape?: UIDataTableShape;
  /** demo size: xs/sm/md/lg/xl */
  size?: ComponentSize;
}