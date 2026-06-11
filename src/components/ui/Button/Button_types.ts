import type { ButtonHTMLAttributes,	MouseEventHandler } from 'react';
import type { ComponentSize } from '@/components/ui/types';

export type UIButtonSize = ComponentSize | 'compact';
export type UIButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link' | 'text' | 'icon-only';
export type UIButtonShape = 'rounded' | 'square' | 'pill';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    href?: string;
    variant?: UIButtonVariant;
    size?: UIButtonSize;
    shape?: UIButtonShape;
    className?: string;
    onClick?: MouseEventHandler<HTMLElement>;
}