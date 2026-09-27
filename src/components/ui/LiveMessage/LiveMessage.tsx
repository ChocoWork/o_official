// File: src/components/ui/LiveMessage/LiveMessage.tsx
import "@/components/ui/LiveMessage/LiveMessage.css";
import type { HTMLAttributes, ReactNode } from "react";

type LiveMessageElement = "p" | "div" | "span";

export interface LiveMessageProps
  extends Omit<HTMLAttributes<HTMLElement>, "role" | "aria-live" | "children"> {
  /** 知らせる文言。空（null / undefined / false / ""）のあいだは入れ物だけを置き、画面と余白から外す */
  children?: ReactNode;
  /**
   * assertive: 操作の結果など、すぐに知らせる案内（role="alert"。読み上げ中でも割り込む）。
   * polite: 欄ごとの誤りなど、まとめて出うる案内（aria-live="polite"。順番待ちで読む）。
   * status: 保存しました などの状況の案内（role="status"。polite と同じく順番待ちで読む。FREQ-377）。
   */
  politeness?: "assertive" | "polite" | "status";
  as?: LiveMessageElement;
}

/**
 * 画面の途中で出る案内を、スクリーンリーダーに確実に読ませるための入れ物（FREQ-376）。
 *
 * 読み上げ領域は、中身が変わる前から置いておかないと読まれないことがある（MDN。Chakra UI #3240 では
 * 表示のたびに差し込んだ案内が NVDA で読まれなかった）。そこで入れ物は常に置き、文言だけを入れ替える。
 * 空のあいだは見た目用のクラスとスタイルを外し、画面と余白からも外す。
 */
export function LiveMessage({
  children,
  politeness = "assertive",
  as: Tag = "p",
  className,
  style,
  ...rest
}: LiveMessageProps) {
  const hasMessage =
    children !== null && children !== undefined && children !== false && children !== "";
  const liveAttrs =
    politeness === "assertive"
      ? ({ role: "alert" } as const)
      : politeness === "status"
        ? ({ role: "status" } as const)
        : ({ "aria-live": "polite", "aria-atomic": true } as const);

  return (
    <Tag
      {...rest}
      {...liveAttrs}
      className={hasMessage ? className : "live-message--empty"}
      style={hasMessage ? style : undefined}
    >
      {hasMessage ? children : null}
    </Tag>
  );
}
