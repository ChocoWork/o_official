import type { InputHTMLAttributes, ReactNode } from 'react';
import type { ComponentSize } from '@/components/ui/types';

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