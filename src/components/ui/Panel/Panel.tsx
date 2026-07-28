import "./Panel.css";
import type { PanelProps } from "@/components/ui/Panel/Panel_type";

export type { PanelProps, PanelTone, PanelRadius } from "@/components/ui/Panel/Panel_type";

/**
 * ダッシュボードの区画。見出し＋操作のヘッダー行と本文を1枚の面に載せる。
 * 見出しを渡さない場合はヘッダー行を描画せず、余白も足さない。
 */
export function Panel({
  children,
  title,
  actions,
  headingLevel = 3,
  headerWrap = true,
  tone = "surface",
  radius = "square",
  size = "md",
  className,
  "aria-label": ariaLabel,
}: PanelProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  return (
    <section
      data-ui-panel=""
      data-ui-panel-tone={tone}
      data-ui-panel-radius={radius}
      data-ui-panel-size={size}
      data-ui-size={size}
      className={className}
      aria-label={ariaLabel}
    >
      {title !== undefined || actions !== undefined ? (
        <div
          data-ui-panel-header=""
          data-ui-panel-header-nowrap={headerWrap ? undefined : "true"}
        >
          {title !== undefined ? (
            <Heading data-ui-panel-title="">{title}</Heading>
          ) : null}
          {actions !== undefined ? (
            <div data-ui-panel-actions="">{actions}</div>
          ) : null}
        </div>
      ) : null}
      <div data-ui-panel-body="">{children}</div>
    </section>
  );
}
