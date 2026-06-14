import "@/components/ui/BannerAlert/BannerAlert.css";
import { cn } from "@/lib/utils";
import type { BannerAlertProps } from "@/components/ui/BannerAlert/BannerAlert_types";

export function BannerAlert({
  title,
  message,
  description,
  variant = "info",
  shape = "square",
  icon,
  dismissible = false,
  onDismiss,
  className,
  size = "md",
}: BannerAlertProps) {
  const contentText = message ?? title ?? "";

  const rootDataAttrs = {
    "data-ui-banner-alert": "true",
    "data-ui-banner-alert-variant": variant,
    "data-ui-banner-alert-shape": shape,
    "data-ui-banner-alert-size": size,
    "data-ui-size": size,
  } as const;

  return (
    <div
      className={cn("banner-alert", className)}
      {...rootDataAttrs}
      role="alert"
    >
      <div className="banner-alert__body">
        {icon ? (
          <span className="banner-alert__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="banner-alert__text">
          {contentText ? (
            <p
              className="banner-alert__title"
              data-ui-banner-alert-has-description={
                description ? "true" : undefined
              }
            >
              {contentText}
            </p>
          ) : null}
          {description ? (
            <p className="banner-alert__description">{description}</p>
          ) : null}
        </div>
      </div>
      {dismissible && onDismiss ? (
        <button
          type="button"
          className="banner-alert__dismiss"
          onClick={onDismiss}
          aria-label="閉じる"
        >
          <span className="banner-alert__dismiss-icon" aria-hidden="true">
            <i className="ri-close-line" />
          </span>
        </button>
      ) : null}
    </div>
  );
}
