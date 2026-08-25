import type { ButtonHTMLAttributes,	MouseEventHandler, Ref } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIButtonSize = ComponentSize | 'compact';
export type UIButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'link' | 'text' | 'subtle';
export type UIButtonShape = 'rounded' | 'square' | 'pill';
/** 選択状態の示し方。fill=塗りつぶし（既定） / outline=白地・黒文字のまま枠線だけ黒くする */
export type UIButtonSelectedTone = 'fill' | 'outline';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    href?: string;
    variant?: UIButtonVariant;
    size?: UIButtonSize;
    shape?: UIButtonShape;
    iconOnly?: boolean;
    /** トグルボタンの選択状態。既定では塗りつぶしで示し、aria-pressed も付与する。 */
    selected?: boolean;
    /** 選択状態の示し方。既定 fill（塗りつぶし）。outline は白地・黒文字のまま枠線だけ黒くする。 */
    selectedTone?: UIButtonSelectedTone;
    className?: string;
    onClick?: MouseEventHandler<HTMLElement>;
    /** button 要素への ref（href 指定時は無効）。React 19 の ref-as-prop で透過的に渡る。 */
    ref?: Ref<HTMLButtonElement>;
}