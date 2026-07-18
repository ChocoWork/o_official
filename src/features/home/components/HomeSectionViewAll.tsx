import { Button } from "@/components/ui/Button/Button";
import { cn } from "@/lib/utils";

// ホーム各セクション（ITEMS / LOOK / NEWS）の末尾に配置する VIEW ALL ボタン。
// 共通 UI の Button（secondary: 白地・黒枠、ホバーで反転）を使用する。
type HomeSectionViewAllProps = {
  href: string;
  /** ページ内に VIEW ALL が複数並ぶため、行き先を区別する名前を必須にする */
  ariaLabel: string;
  className?: string;
};

export function HomeSectionViewAll({
  href,
  ariaLabel,
  className,
}: HomeSectionViewAllProps) {
  return (
    <div
      className={cn(
        "mt-[34px] flex justify-center sm:mt-[42px] md:mt-[55px]",
        className,
      )}
    >
      <Button
        href={href}
        variant="secondary"
        size="3xs"
        shape="square"
        aria-label={ariaLabel}
        data-testid="home-section-view-all"
        className="min-h-[52px] w-full max-w-[420px] font-brand uppercase tracking-[0.2em]"
      >
        VIEW ALL
      </Button>
    </div>
  );
}
