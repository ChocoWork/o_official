import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface MapViewProps {
  title?: string;
  children?: ReactNode;
  embedUrl?: string;
  showTitle?: boolean;
  className?: string;
  embedWrapperClassName?: string;
  iframeClassName?: string;
}

export function MapView({
  title = 'Map',
  children,
  embedUrl,
  showTitle = false,
  className,
  embedWrapperClassName,
  iframeClassName,
}: MapViewProps) {
  if (embedUrl) {
    return (
      <div className={cn('aspect-video bg-[#f5f5f5] border border-black/20', className)}>
        <iframe
          src={embedUrl}
          title={title}
          className={cn('h-full w-full', iframeClassName)}
          width="100%"
          height="100%"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          style={{ border: 0 }}
          allowFullScreen
        ></iframe>
      </div>
    );
  }

  return (
    <div className={cn('border border-black/20 bg-[#f5f5f5]', className)}>
      {showTitle ? <p className="mb-2 px-4 pt-4 text-xs tracking-wider text-[#474747]">{title}</p> : null}
      <div className={cn('flex min-h-48 items-center justify-center border border-dashed border-black/20 bg-white text-sm text-[#474747]', embedWrapperClassName)}>
        {children ?? 'マップ表示エリア'}
      </div>
    </div>
  );
}
