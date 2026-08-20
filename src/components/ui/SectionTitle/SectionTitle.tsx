import "./SectionTitle.css";
import clsx from "clsx";

// ITEMS / LOOK / NEWS / ABOUT / STOCKIST など全セクション共通の見出し。
// 文字サイズは hyke.jp の NEW IN / NEWS に合わせ、1024px 未満 20px・以上 28px。
type SectionTitleProps = {
  title: string;
  className?: string;
};

export function SectionTitle({ title, className }: SectionTitleProps) {
  return (
    <div
      className={clsx(
        "text-left mb-2.75 sm:mb-6.5 md:mb-8.5 lg:mb-13.75",
        className,
      )}
    >
      <h2
        className={clsx(
          "text-5 lg:text-7 leading-none underline underline-offset-8 decoration-black decoration-1 mb-4 sm:mb-4.5 md:mb-5 tracking-tight",
        )}
      >
        {title}
      </h2>
    </div>
  );
}
