import "./MapView.css";
import type { MapViewProps } from "./MapView_types";

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
  if (embedUrl) {
    return (
      <div
        data-ui-mapview="true"
        data-ui-mapview-size={size}
        data-ui-mapview-variant="embed"
        className={className}
      >
        <iframe
          data-mapview-iframe=""
          src={embedUrl}
          title={title}
          className={iframeClassName}
          width="100%"
          height="100%"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <div
      data-ui-mapview="true"
      data-ui-mapview-size={size}
      data-ui-mapview-variant="default"
      className={className}
    >
      {showTitle && <p data-mapview-title="">{title}</p>}
      <div data-mapview-placeholder="" className={embedWrapperClassName}>
        {children ?? 'マップ表示エリア'}
      </div>
    </div>
  );
}
