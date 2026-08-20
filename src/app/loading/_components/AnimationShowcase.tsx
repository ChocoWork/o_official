"use client";

import { useState } from "react";
import FadeIn from "@/components/animations/FadeIn";
import StaggerChildren from "@/components/animations/StaggerChildren";
import PageTransition from "@/components/animations/PageTransition";
import HoverScale from "@/components/animations/HoverScale";
import MagneticButton from "@/components/animations/MagneticButton";
import TextReveal from "@/components/animations/TextReveal";
import AnimatedCounter from "@/components/animations/AnimatedCounter";
import CodeBlock from "./CodeBlock";

const animationComponents = [
  {
    name: "FadeIn",
    description:
      "要素がスクロールでふわっと表示。directionで上下左右からの方向を指定。",
    demo: (
      <FadeIn
        delay={0}
        duration={600}
        direction="up"
        distance={20}
        once={false}
      >
        <div
          className="px-5.25 py-3.25 bg-black text-white text-2.75 tracking-widest"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          FADE IN
        </div>
      </FadeIn>
    ),
    code: `import FadeIn from '@/components/animations/FadeIn';

<FadeIn
  delay={0}
  duration={600}
  direction="up"
  distance={20}
>
  <div>コンテンツ</div>
</FadeIn>`,
  },
  {
    name: "StaggerChildren",
    description:
      "子要素を順番にアニメーション表示。カードリストやメニューに最適。",
    demo: (
      <StaggerChildren
        staggerDelay={100}
        baseDelay={0}
        duration={400}
        direction="up"
        distance={15}
        once={false}
      >
        <div className="flex gap-1.25">
          <div className="w-2 h-2 bg-black rounded-full"></div>
          <div className="w-2 h-2 bg-black rounded-full"></div>
          <div className="w-2 h-2 bg-black rounded-full"></div>
        </div>
      </StaggerChildren>
    ),
    code: `import StaggerChildren from '@/components/animations/StaggerChildren';

<StaggerChildren
  staggerDelay={100}
  baseDelay={0}
  duration={400}
  direction="up"
  distance={15}
>
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</StaggerChildren>`,
  },
  {
    name: "PageTransition",
    description:
      "ページ遷移時に全体をフェードイン。layout.tsxや各page.tsxでラップする。",
    demo: (
      <PageTransition duration={500}>
        <div
          className="px-5.25 py-3.25 border border-black text-2.75 tracking-widest"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          PAGE TRANSITION
        </div>
      </PageTransition>
    ),
    code: `import PageTransition from '@/components/animations/PageTransition';

<PageTransition duration={500}>
  <main>ページコンテンツ</main>
</PageTransition>`,
  },
  {
    name: "HoverScale",
    description: "ホバーでスケールアップ。商品画像やカードに。",
    demo: (
      <HoverScale scale={1.05} duration={300}>
        <div
          className="px-5.25 py-3.25 bg-black text-white text-2.75 tracking-widest"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          HOVER ME
        </div>
      </HoverScale>
    ),
    code: `import HoverScale from '@/components/animations/HoverScale';

<HoverScale scale={1.05} duration={300}>
  <div>商品カード</div>
</HoverScale>`,
  },
  {
    name: "MagneticButton",
    description: "マウスに引き付けられるボタン。CTAボタンに使用。",
    demo: (
      <MagneticButton strength={0.3}>
        <div
          className="px-5.25 py-3.25 bg-black text-white text-2.75 tracking-widest"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          MAGNETIC
        </div>
      </MagneticButton>
    ),
    code: `import MagneticButton from '@/components/animations/MagneticButton';

<MagneticButton strength={0.3}>
  <button>CTAボタン</button>
</MagneticButton>`,
  },
  {
    name: "TextReveal",
    description: "文字が1文字ずつ表示される。見出しやブランド名に。",
    demo: (
      <TextReveal
        text="Le Fil"
        className="text-4 text-black"
        stagger={50}
        delay={0}
        once={false}
      />
    ),
    code: `import TextReveal from '@/components/animations/TextReveal';

<TextReveal
  text="Le Fil des Heures"
  className="text-4 text-black"
  stagger={50}
  delay={0}
/>`,
  },
  {
    name: "AnimatedCounter",
    description: "数字がスクロールでカウントアップ。KPIや統計表示に。",
    demo: (
      <div className="px-5.25 py-3.25 border border-black">
        <AnimatedCounter
          target={2026}
          prefix=""
          suffix=""
          duration={1500}
          className="text-4 text-black"
        />
      </div>
    ),
    code: `import AnimatedCounter from '@/components/animations/AnimatedCounter';

<AnimatedCounter
  target={2026}
  prefix=""
  suffix=""
  duration={1500}
  className="text-4 text-black"
/>`,
  },
];

export default function AnimationShowcase() {
  // REPLAY でデモを再マウントし、マウント時／ビューポート進入時のアニメーションを再実行する
  const [replayKeys, setReplayKeys] = useState<Record<string, number>>({});

  const replay = (name: string) => {
    setReplayKeys((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
  };

  return (
    <div className="space-y-8.5">
      {animationComponents.map((comp) => (
        <div
          key={comp.name}
          className="border border-black/10 p-5.25 sm:p-6.5 md:p-8.5"
        >
          <div className="flex flex-col sm:flex-row sm:items-start gap-3.25 sm:gap-5.25 md:gap-8.5">
            <div className="shrink-0 w-full sm:w-50 md:w-58.25">
              <p
                className="text-3.25 sm:text-3.5 text-black mb-1.25 sm:mb-2"
                style={{ fontFamily: "Didot, serif" }}
              >
                {comp.name}
              </p>
              <p
                className="text-2.5 sm:text-2.75 text-black/50 leading-[1.7]"
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                {comp.description}
              </p>
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-center min-h-13.75 sm:min-h-17 bg-[#fafafa] border border-black/5 mb-3.25 p-3.25">
                <div key={replayKeys[comp.name] ?? 0}>{comp.demo}</div>
              </div>
              <div className="flex items-start gap-5.25">
                <button
                  onClick={() => replay(comp.name)}
                  className="mt-3.25 flex items-center gap-1.25 text-2.5 text-black/30 tracking-[0.15em] hover:text-black/60 transition-colors cursor-pointer"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                  aria-label={`${comp.name} のアニメーションを再生`}
                >
                  <i className="ri-restart-line w-3 h-3 flex items-center justify-center"></i>
                  REPLAY
                </button>
                <div className="flex-1">
                  <CodeBlock code={comp.code} label={comp.name} />
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
