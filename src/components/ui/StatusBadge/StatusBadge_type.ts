import type { ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type StatusBadgeTone = 'neutral' | 'positive' | 'warning' | 'danger';
export type StatusBadgeVariant = 'text' | 'count' | 'dot';
/** 角。square＝直角（既定）、rounded＝input と揃う 8px、pill＝全丸。 */
export type StatusBadgeShape = 'square' | 'rounded' | 'pill';
/** 高さの決め方。control は隣接するフォームコントロールと高さを揃える。 */
export type StatusBadgeHeight = 'auto' | 'control';

export interface StatusBadgeProps {
  children?: ReactNode;
  tone?: StatusBadgeTone;
  variant?: StatusBadgeVariant;
  count?: number | string;
  className?: string;
  size?: ComponentSize;
  shape?: StatusBadgeShape;
  /**
   * 高さの決め方。auto＝内容なり（既定）、control＝隣に並ぶ Button /
   * SingleSelect と同じ φ 式（2×pad-y + font×√φ + 2×border）で揃える。
   */
  height?: StatusBadgeHeight;
  /**
   * tone を色で示す（positive＝緑・warning＝橙・danger＝赤）。
   * 既定は false＝モノクロのままなので、既存の呼び出しは見た目が変わらない。
   */
  accent?: boolean;
}
