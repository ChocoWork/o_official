import type {
	InputHTMLAttributes,
	SelectHTMLAttributes,
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

