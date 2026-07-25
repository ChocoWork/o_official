import type { ButtonHTMLAttributes,	MouseEventHandler } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIButtonSize = ComponentSize | 'compact';
export type UIButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'link' | 'text' | 'subtle';
export type UIButtonShape = 'rounded' | 'square' | 'pill';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    href?: string;
    variant?: UIButtonVariant;
    size?: UIButtonSize;
    shape?: UIButtonShape;
    iconOnly?: boolean;
    /** トグルボタンの選択状態。variant を問わず塗りつぶしで示し、aria-pressed も付与する。 */
    selected?: boolean;
    className?: string;
    onClick?: MouseEventHandler<HTMLElement>;
}