import type { ReactNode } from 'react';
import type { ComponentSize } from '../types';

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