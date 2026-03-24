import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { ComponentSize } from './types';

export interface MapViewProps {
  title?: string;
  children?: ReactNode;
  embedUrl?: string;
  showTitle?: boolean;
  className?: string;
  embedWrapperClassName?: string;
  iframeClassName?: string;
  /** 表示サイズ。sm/md/lg。高さや最小高さが調整される。 */
  size?: ComponentSize;
}

export function MapView({
  title = 'Map',
  children,
  embedUrl,
  showTitle = false,
  className,
  embedWrapperClassName,
  iframeClassName,
  size = 'md',
}: MapViewProps) {
  // for sm, width and height should be half of lg
  const containerMap: Record<ComponentSize, string> = {
    sm: 'w-1/2 h-40',
    md: 'w-3/4 h-60', // md narrower than full width
    lg: 'w-full h-80', // fallback for non-embed (unused when embedUrl lg)
  };
  const minHMap: Record<ComponentSize, string> = {
    sm: 'min-h-24',
    md: 'min-h-36',
    lg: 'min-h-48', // as per requested size for lg non-embed
  };
  const containerClass = containerMap[size];
  const minHClass = minHMap[size];
  if (embedUrl) {
    // always enforce 16:9 aspect ratio via aspect-video
    // width varies by size: sm half, md three-quarters, lg full
    const widthMap: Record<ComponentSize, string> = {
      sm: 'w-1/2',
      md: 'w-3/4',
      lg: 'w-full',
    };
    const embedClass = `aspect-video ${widthMap[size]}`;
    return (
      <div className={cn(embedClass + ' bg-[#f5f5f5] border border-black/20 mx-auto', className)}>
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
    <div className={cn(containerClass, 'border border-black/20 bg-[#f5f5f5] mx-auto', className)}>
      {showTitle ? <p className="mb-2 px-4 pt-4 text-xs tracking-wider text-[#474747]">{title}</p> : null}
      <div className={cn('flex items-center justify-center border border-dashed border-black/20 bg-white text-sm text-[#474747]', minHClass, embedWrapperClassName)}>
        {children ?? 'マップ表示エリア'}
      </div>
    </div>
  );
}
