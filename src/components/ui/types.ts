import type {
	ButtonHTMLAttributes,
	InputHTMLAttributes,
	SelectHTMLAttributes,
	MouseEventHandler,
	ReactNode,
} from 'react';

export type ComponentSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface SelectOption {
	value: string;
	label: string;
}

export interface SingleSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
	label?: string;
	options: SelectOption[];
	placeholder?: string;
	variant?: 'native' | 'dropdown';
	onValueChange?: (value: string) => void;
	size?: ComponentSize;
}

export interface MultiSelectProps {
	options: SelectOption[];
	values: string[];
	onChange: (values: string[]) => void;
	label?: string;
	placeholder?: string;
	variant?: 'panel' | 'dropdown' | 'buttons';
	size?: ComponentSize;
	/** 'check' = native checkbox (default), 'fill' = solid black square */
	checkStyle?: 'check' | 'fill';
	shape?: 'square' | 'rounded';
	expandLabelHitArea?: boolean;
	renderOptionLabel?: (option: SelectOption, selected: boolean) => ReactNode;
	className?: string;
}

export type UIButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link' | 'text';
export type UIButtonSize = ComponentSize | 'compact';
export type UIButtonShape = 'rounded' | 'square' | 'pill';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	href?: string;
	variant?: UIButtonVariant;
	size?: UIButtonSize;
	shape?: UIButtonShape;
	className?: string;
	onClick?: MouseEventHandler<HTMLElement>;
}

export interface EmptyPageProps {
	iconClassName: string;
	label: ReactNode;
	buttonLabel: ReactNode;
	href?: string;
	onButtonClick?: () => void;
	size?: ComponentSize;
	className?: string;
	buttonClassName?: string;
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

