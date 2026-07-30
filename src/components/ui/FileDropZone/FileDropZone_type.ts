// File: src/components/ui/FileDropZone/FileDropZone_type.ts
import type { ReactNode } from "react";
import type { ComponentSize } from "@/components/ui/types";

/** 角。square＝直角、rounded＝input と揃う 8px（既定）。 */
export type FileDropZoneShape = "square" | "rounded";

export interface FileDropZoneProps {
  /** ドロップ／選択されたファイル。複数不可のときも配列で渡す。 */
  onFiles: (files: File[]) => void;
  /** input[type=file] の accept。 */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** 面の中央に置く主文言。 */
  label?: ReactNode;
  /** 主文言の下に置く補足（対応形式・上限など）。 */
  hint?: ReactNode;
  /** 処理中。文言を差し替え、入力を止める。 */
  busy?: boolean;
  busyLabel?: ReactNode;
  size?: ComponentSize;
  shape?: FileDropZoneShape;
  className?: string;
  /** ファイル入力の名前（スクリーンリーダー・テストの参照に使う）。 */
  "aria-label": string;
}
