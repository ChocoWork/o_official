/**
 * ホームの ITEM・LOOK・NEWS の区画の末尾に置く VIEW ALL ボタン（src/features/home/components/HomeSectionViewAll.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-HOME-102
 * @design DD-HOME-002
 * @remarks ITEM・LOOK・NEWS の区画の下から一覧へ移る入口を、同じ見た目の共通のボタン1つにまとめるため、共通 UI の Button に載せる。
 */
import { Button } from "@/components/ui/Button/Button";
import { cn } from "@/lib/utils";

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
        "mt-8.5 flex justify-center sm:mt-10.5 md:mt-13.75",
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
        className="min-h-13 w-full max-w-105 font-brand uppercase tracking-[0.2em]"
      >
        VIEW ALL
      </Button>
    </div>
  );
}
