import { cn } from "@/lib/utils";

// ホーム3セクション（ITEMS / LOOKBOOK / NEWS）共通のセクション見出し。
// 左に Didot のタイトルを配置する。VIEW ALL 導線はセクション末尾の
// HomeSectionViewAll に配置する。
type HomeSectionHeaderProps = {
  title: string;
  className?: string;
};

export function HomeSectionHeader({ title, className }: HomeSectionHeaderProps) {
  return (
    <div className={cn("mb-[21px] sm:mb-[26px] md:mb-[34px]", className)}>
      <h2 className="tracking-tight leading-none" style={{ fontSize: "var(--lk-size-2xl)" }}>
        {title}
      </h2>
    </div>
  );
}
