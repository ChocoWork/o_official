import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type GraphVariant = 'progress' | 'bars' | 'donut';

/** progress の行組み。stacked＝ラベルと値を track の上（既定）、inline＝1行に並べる。 */
export type GraphLayout = 'stacked' | 'inline';

export interface GraphDatum {
  label: string;
  value: number;
  color?: string;
  /** 値の表示文字列。省略時は value をそのまま出す（金額の整形などに使う）。 */
  formattedValue?: string;
  /** track の長さに使う値。省略時は value（マイナス値を絶対値で描くときに使う）。 */
  magnitude?: number;
}

export interface GraphProps {
  data: readonly GraphDatum[];
  maxValue?: number;
  variant?: GraphVariant;
  className?: string;
  legendClassName?: string;
  size?: ComponentSize | number;
  /** 凡例を描くか（donut のみ）。外側で件数付きの凡例を組むときは false。 */
  showLegend?: boolean;
  /** donut の中央に重ねる内容（合計値など）。 */
  centerLabel?: ReactNode;
  /** progress の行組み。 */
  layout?: GraphLayout;
}
