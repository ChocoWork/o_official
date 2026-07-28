// File: src/components/ui/Panel/Panel_type.ts
import type { ReactNode } from "react";
import type { ComponentSize } from "@/components/ui/types";

/** 面の性格。surface＝白、muted＝一段沈めた面（補足・集計）。 */
export type PanelTone = "surface" | "muted";

/** 角丸。square＝直角（従来の管理画面）、rounded＝input と揃う 8px。 */
export type PanelRadius = "square" | "rounded";

export interface PanelProps {
  children?: ReactNode;
  /** 見出し。渡すとヘッダー行を描画する。 */
  title?: ReactNode;
  /** 見出し行の右端に置く操作・補足（CSV出力・表示切替・期間表示など）。 */
  actions?: ReactNode;
  /** 見出しの意味的なレベル。既定は h3。 */
  headingLevel?: 2 | 3 | 4;
  /**
   * 見出しが入りきらないとき、操作を下段へ折り返すか。
   * false なら折り返さず、見出し側が縮む（狭いカラムに3枚並べる用）。
   */
  headerWrap?: boolean;
  tone?: PanelTone;
  radius?: PanelRadius;
  /** パディング・フォントの基準サイズ。 */
  size?: ComponentSize;
  className?: string;
  /** 見出しを持たない、または見出しと別名を付けたいときの section 名。 */
  "aria-label"?: string;
}
