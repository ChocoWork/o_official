import type {
	ButtonHTMLAttributes,
	InputHTMLAttributes,
	MouseEventHandler,
	ReactNode,
} from 'react';

export type ComponentSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export type UIButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
export type UIButtonSize = ComponentSize;
export type UIButtonShape = 'rounded' | 'square' | 'pill';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	href?: string;
	variant?: UIButtonVariant | 'text';
	size?: UIButtonSize;
	shape?: UIButtonShape;
	className?: string;
	onClick?: MouseEventHandler<HTMLElement>;
}

export type UICheckboxCheckStyle = 'check' | 'fill';
export type UICheckboxShape = 'square' | 'rounded';

export interface CheckboxProps
	extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className'> {
	label: ReactNode;
	size?: ComponentSize;
	checkStyle?: UICheckboxCheckStyle;
	shape?: UICheckboxShape;
	expandLabelHitArea?: boolean;
	className?: string;
	inputClassName?: string;
}

