import Link from "next/link";
import { cn } from "@/lib/utils";

// ホーム3セクション（ITEMS / LOOKBOOK / NEWS）共通のセクション見出し。
// 左に Didot のタイトル、右に VIEW ALL リンク（矢印付き）を下端揃えで配置する。
// 対比: タイトル（2xl・serif）と VIEW ALL（3xs・sans・トラッキング広）で
// 情報の優先度を明確にする。
type HomeSectionHeaderProps = {
  title: string;
  viewAllHref: string;
  /** ページ内に VIEW ALL リンクが複数並ぶため、行き先を区別する名前を必須にする */
  viewAllAriaLabel: string;
  className?: string;
};

export function HomeSectionHeader({
  title,
  viewAllHref,
  viewAllAriaLabel,
  className,
}: HomeSectionHeaderProps) {
  return (
    // タイトルと VIEW ALL は items-baseline で文字のベースラインを揃える
    // （items-end だと VIEW ALL 側の min-h 内センタリング分だけ浮いてずれる）
    <div
      className={cn(
        "flex items-baseline justify-between gap-[21px] mb-[21px] sm:mb-[26px] md:mb-[34px]",
        className,
      )}
    >
      <h2 className="tracking-tight leading-none" style={{ fontSize: "var(--lk-size-2xl)" }}>
        {title}
      </h2>
      <Link
        href={viewAllHref}
        aria-label={viewAllAriaLabel}
        data-testid="home-section-view-all"
        className="group inline-flex min-h-[34px] items-center gap-[8px] font-brand tracking-[0.18em] text-black transition-colors hover:text-[#474747]"
        style={{ fontSize: "var(--lk-size-3xs)" }}
      >
        VIEW ALL
        <i
          className="ri-arrow-right-line transition-transform duration-300 motion-safe:group-hover:translate-x-[3px]"
          aria-hidden="true"
        />
      </Link>
    </div>
  );
}
