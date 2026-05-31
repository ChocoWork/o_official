import type { SelectHTMLAttributes } from 'react';
import type { ComponentSize, SelectOption } from '@/components/ui/types';

export interface SingleSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
	label?: string;
	options: SelectOption[];
	placeholder?: string;
	variant?: 'native' | 'dropdown';
	onValueChange?: (value: string) => void;
	size?: ComponentSize;
}