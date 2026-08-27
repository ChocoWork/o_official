import type { ButtonHTMLAttributes,	MouseEventHandler } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIButtonSize = ComponentSize | 'compact';
export type UIButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'link' | 'text' | 'subtle';
export type UIButtonShape = 'rounded' | 'square' | 'pill';
/** 選択状態の示し方。fill=塗りつぶし（既定） / outline=塗らずに枠線だけで示す */
export type UIButtonSelectedTone = 'fill' | 'outline';
/** 外形比。auto=内容なり（既定） / square=短いラベルを正方形に収める（内容が広ければ長方形に伸びる） */
export type UIButtonAspect = 'auto' | 'square';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    href?: string;
    variant?: UIButtonVariant;
    size?: UIButtonSize;
    shape?: UIButtonShape;
    iconOnly?: boolean;
    /** トグルボタンの選択状態。既定では塗りつぶしで示し、aria-pressed も付与する。 */
    selected?: boolean;
    /** 選択状態の示し方。既定 fill（塗りつぶし）。outline は面を塗らず枠線だけで示す。 */
    selectedTone?: UIButtonSelectedTone;
    /** 外形比。square は1辺をボタン高さに揃えた正方形にする（内容が広い場合のみ横に伸びる）。 */
    aspect?: UIButtonAspect;
    className?: string;
    onClick?: MouseEventHandler<HTMLElement>;
}