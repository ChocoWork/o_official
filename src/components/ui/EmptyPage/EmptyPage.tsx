"use client";

import '@/components/ui/EmptyPage/EmptyPage.css';
import { Button } from '@/components/ui/Button/Button';
import type { EmptyPageProps } from '@/components/ui/EmptyPage/EmptyPage_types';

export function EmptyPage({
	iconClassName,
	label,
	buttonLabel,
	href = '/item',
	onButtonClick,
	size,
	className,
	buttonClassName,
}: EmptyPageProps) {
	return (
		<div
			className={`empty-page ${className ?? ''}`.trim()}
			data-ui-empty-page="true"
			data-ui-empty-page-size={size}
		>
			<div className="empty-page__inner">
				<div className="empty-page__figure">
					<i aria-hidden="true" className={`empty-page__icon ${iconClassName}`} />
					<span className="empty-page__label">{label}</span>
				</div>

				<Button href={href} size={size} onClick={onButtonClick} className={buttonClassName}>
					{buttonLabel}
				</Button>
			</div>
		</div>
	);
}
