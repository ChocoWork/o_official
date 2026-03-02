import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface BannerAlertProps {
  title?: string;
  message?: string;
  description?: string;
  variant?: 'info' | 'warning' | 'error' | 'success';
  icon?: ReactNode;
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
}

const bannerTone: Record<NonNullable<BannerAlertProps['variant']>, string> = {
  info: 'bg-black text-white',
  warning: 'bg-[#f5f5f5] border border-black/20 text-black',
  error: 'border-l-4 border-black bg-[#f5f5f5] text-black',
  success: 'bg-white border border-black/20 text-black',
};

export function BannerAlert({
  title,
  message,
  description,
  variant = 'info',
  icon,
  dismissible = false,
  onDismiss,
  className,
}: BannerAlertProps) {
  const contentText = message ?? title ?? '';

  return (
    <div
      className={cn(
        'flex items-start justify-between px-6 py-4',
        variant !== 'info' ? 'border' : null,
        bannerTone[variant],
        className,
      )}
    >
      <div className={cn('flex gap-3', description ? 'items-start' : 'items-center')}>
        {icon ? (
          <div className={cn('flex h-5 w-5 items-center justify-center', description ? 'mt-0.5' : null)}>{icon}</div>
        ) : null}
        <div>
          {contentText ? (
            <p className={cn('text-sm', description ? 'mb-1 text-black' : null)} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {contentText}
            </p>
          ) : null}
          {description ? (
            <p className="text-sm leading-relaxed text-black/60" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {dismissible && onDismiss ? (
        <button
          type="button"
          className={cn(
            'flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center transition-colors',
            variant === 'info' ? 'hover:bg-white/20' : 'hover:bg-black/10',
          )}
          onClick={onDismiss}
        >
          <div className="flex h-4 w-4 items-center justify-center">
            <i className={cn('ri-close-line text-base', variant === 'info' ? 'text-white' : 'text-black')}></i>
          </div>
        </button>
      ) : null}
    </div>
  );
}
