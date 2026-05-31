import type { ReactNode } from 'react';
import type { ComponentSize, SelectOption } from '@/components/ui/types';

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