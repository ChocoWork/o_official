import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type GraphVariant =
  | 'progress'
  | 'bars'
  | 'donut'
  /** 軸付きの折れ線（棒との併用可）。残高推移・償却推移。 */
  | 'line'
  /** 軸付きの積み上げ棒。資産・負債・純資産の推移。 */
  | 'stacked-bars'
  /** 軸付きの滝グラフ。増減要因の内訳。 */
  | 'waterfall';

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
  /**
   * waterfall の両端（前月残高・当月残高）。増減ではなく総額なので
   * 0 から積み上げ、次のブロックの起点になる。
   */
  total?: boolean;
}

/** 軸付きグラフ（line / stacked-bars）の1系列。値は categories と同じ順・同じ長さ。 */
export interface GraphSeries {
  label: string;
  values: readonly (number | null)[];
  color?: string;
  /** 折れ線ではなく棒で描く（line の背面に置く）。既定は line。 */
  kind?: 'line' | 'bar';
  /** 破線で描く（予測・比較の系列）。kind='line' のみ。 */
  dashed?: boolean;
  /** 斜線ハッチで塗る（予測の棒）。kind='bar' のみ。 */
  hatched?: boolean;
  /** 点を打たない（比較用の参照系列など）。 */
  hideDots?: boolean;
}

/** 特定の点を強調する（異常値の指摘）。 */
export interface GraphMarker {
  seriesIndex: number;
  index: number;
  color?: string;
}

/** 水平の参照線（前期末残高・安全水準など）。 */
export interface GraphReferenceLine {
  value: number;
  color?: string;
  dashed?: boolean;
}

/**
 * 凡例の1項目。系列から自動生成するほか、
 * referenceLine / markers のように系列を持たない要素の説明にも使う。
 */
export interface GraphLegendEntry {
  label: string;
  color: string;
  /** line＝線、bar＝矩形、dot＝点。 */
  kind: 'line' | 'bar' | 'dot';
  dashed?: boolean;
  hatched?: boolean;
}

/** 右側の第2軸。桁の違う系列を1枚に載せるための設定。 */
export interface GraphRightAxis {
  /** 右軸で描く系列の index（series 配列の位置）。 */
  seriesIndexes: readonly number[];
  /** 右軸の単位表記（「（円）」など）。 */
  unitLabel?: string;
  /** 右軸の目盛りラベルの整形。省略時は左軸と同じ整形。 */
  formatAxisValue?: (value: number) => string;
}

export interface GraphProps {
  /** progress / bars / donut / waterfall の系列。軸付きの line / stacked-bars では使わない。 */
  data?: readonly GraphDatum[];
  maxValue?: number;
  variant?: GraphVariant;
  className?: string;
  legendClassName?: string;
  size?: ComponentSize | number;
  /** 凡例を描くか（donut・軸付きグラフ）。外側で件数付きの凡例を組むときは false。 */
  showLegend?: boolean;
  /** donut の中央に重ねる内容（合計値など）。 */
  centerLabel?: ReactNode;
  /** progress の行組み。 */
  layout?: GraphLayout;

  /* ── 軸付きグラフ（line / stacked-bars / waterfall）─────────────────── */
  /** 横軸のカテゴリ名（月・年度）。 */
  categories?: readonly string[];
  /** line / stacked-bars の系列。 */
  series?: readonly GraphSeries[];
  /** 縦軸の単位表記（「（円）」など）を左上に出す。 */
  unitLabel?: string;
  /** 強調する点。 */
  markers?: readonly GraphMarker[];
  referenceLine?: GraphReferenceLine;
  /**
   * この index 以降を予測として縦の点線で区切る。
   * 折れ線は境界の手前まで実線・以降は破線、棒は以降をハッチで塗り、
   * 凡例も系列ごとに「（実績）」「（予測）」の2項目へ分ける。
   */
  forecastFrom?: number;
  forecastLabels?: { readonly past: string; readonly future: string };
  /** 凡例の「（実績）」「（予測）」の呼び方。 */
  forecastSeriesLabels?: { readonly actual: string; readonly forecast: string };
  /** 系列から作れない凡例（参照線・強調点）を後ろに足す。 */
  extraLegend?: readonly GraphLegendEntry[];
  /**
   * 棒の系列をスロット内で横に並べる（既定は同じ位置に重ねる）。
   * 売上と経費のように「同じ月の2本を見比べる」ときに使う。
   */
  groupBars?: boolean;
  /**
   * 右側の第2軸。桁が2〜3桁違う系列（金額と件数、売上と所得）を
   * 1枚に載せるときだけ使う。指定した系列は右軸のスケールで描く。
   */
  rightAxis?: GraphRightAxis;
  /** 縦軸の目盛りラベルの整形。省略時は 3桁区切り。 */
  formatAxisValue?: (value: number) => string;
  /** 点・棒に添える値ラベルの整形。渡すと値ラベルを描く（waterfall は既定で描く）。 */
  formatValueLabel?: (value: number) => string;
  /** 図の高さ（px）。省略時は variant ごとの既定値。 */
  plotHeight?: number;
  /**
   * 図の設計幅（px）。SVG は width:100% で伸縮するため、
   * 実際の描画幅に近い値を渡すと文字が意図した大きさで出る。
   */
  plotWidth?: number;
  /**
   * 軸付きグラフの左余白（px）。既定は目盛りラベルが 3桁区切りの金額でも
   * 収まる幅。短いラベルしか出ないときに詰めて作図領域を広げるために使う。
   * "auto" は実際の目盛りラベルの長さから幅を決める。
   */
  plotPadLeft?: number | "auto";
  /** SVG の代替テキスト。軸付きグラフでは必須に近い。 */
  ariaLabel?: string;
}
