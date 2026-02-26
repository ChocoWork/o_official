import type { ReactNode } from 'react';

export interface MapViewProps {
  title?: string;
  children?: ReactNode;
  embedUrl?: string;
}

export function MapView({ title = 'Map', children, embedUrl }: MapViewProps) {
  return (
    <div className="border border-black/10 bg-[#f5f5f5] p-4">
      <p className="mb-2 text-xs tracking-wider text-[#474747]">{title}</p>
      {embedUrl ? (
        <div className="overflow-hidden border border-black/20 bg-white">
          <iframe
            src={embedUrl}
            title={title}
            className="h-64 w-full"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            style={{ border: 0 }}
            allowFullScreen
          />
        </div>
      ) : (
        <div className="flex min-h-48 items-center justify-center border border-dashed border-black/20 bg-white text-sm text-[#474747]">
          {children ?? 'マップ表示エリア'}
        </div>
      )}
    </div>
  );
}
