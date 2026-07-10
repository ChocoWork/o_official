'use client';

import { useState, useEffect } from 'react';
import CodeBlock from './CodeBlock';

const brandName = 'Le Fil des Heures';

const patterns = [
  {
    name: 'THREAD DRAW',
    usage: '見出しとコンテンツを繋ぐ糸。セクション区切り・ページ導入に。',
    render: (
      <div className="flex flex-col items-center">
        <span className="text-[13px] tracking-wider text-black mb-[8px]" style={{ fontFamily: 'Didot, serif' }}>
          Chapter
        </span>
        <div className="w-px h-[55px] bg-black origin-top animate-[threadDraw_3s_ease-in-out_infinite]" />
      </div>
    ),
    code: `<div className="flex flex-col items-center">
  <span style={{ fontFamily: 'Didot, serif' }}>Chapter</span>
  <div className="w-px h-[55px] bg-black origin-top animate-[threadDraw_3s_ease-in-out_infinite]" />
</div>

/* globals.css or style tag */
@keyframes threadDraw {
  0% { transform: scaleY(0); }
  55% { transform: scaleY(1); }
  100% { transform: scaleY(1); }
}`,
  },
  {
    name: 'IMAGE WIPE',
    usage: '商品・LOOK画像のスクロール出現。左から静かに開く。',
    render: (
      <div className="w-[144px] h-[89px] bg-gradient-to-br from-[#e8e6e2] to-[#c9c4bc] animate-[imageWipe_3s_ease-in-out_infinite]" />
    ),
    code: `<div className="overflow-hidden">
  <img src="..." className="animate-[imageWipe_1.2s_ease-out_both]" />
</div>

/* globals.css or style tag（デモはループ、本番は both で1回） */
@keyframes imageWipe {
  0% { clip-path: inset(0 100% 0 0); }
  55% { clip-path: inset(0 0 0 0); }
  85% { clip-path: inset(0 0 0 0); }
  100% { clip-path: inset(0 100% 0 0); }
}`,
  },
  {
    name: 'SLOW ZOOM',
    usage: 'ITEMカードのホバー。画像だけがゆっくり寄る。',
    render: (
      <div className="group w-[144px] cursor-pointer">
        <div className="overflow-hidden">
          <div className="w-full h-[89px] bg-gradient-to-br from-[#e8e6e2] to-[#c9c4bc] transition-transform duration-[1200ms] ease-out group-hover:scale-[1.06]" />
        </div>
        <p className="mt-[8px] text-[10px] tracking-[0.15em] text-black/60" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          HOVER ME
        </p>
      </div>
    ),
    code: `<div className="group cursor-pointer">
  <div className="overflow-hidden">
    <img src="..." className="transition-transform duration-[1200ms] ease-out group-hover:scale-[1.06]" />
  </div>
  <p>ITEM NAME</p>
</div>`,
  },
  {
    name: 'UNDERLINE TRACK',
    usage: 'ナビ・テキストリンクのホバー。下線が走り字間が開く。',
    render: (
      <span className="group relative cursor-pointer text-[12px] tracking-[0.1em] text-black transition-all duration-500 hover:tracking-[0.25em]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
        DISCOVER
        <span className="absolute left-0 -bottom-[3px] h-px w-full origin-left scale-x-0 bg-black transition-transform duration-500 group-hover:scale-x-100" />
      </span>
    ),
    code: `<span className="group relative cursor-pointer tracking-[0.1em] transition-all duration-500 hover:tracking-[0.25em]">
  DISCOVER
  <span className="absolute left-0 -bottom-[3px] h-px w-full origin-left scale-x-0 bg-black transition-transform duration-500 group-hover:scale-x-100" />
</span>`,
  },
  {
    name: 'FILL SWEEP',
    usage: 'CTAボタンのホバー。黒が左から満ちて文字が反転。',
    render: (
      <button className="group relative overflow-hidden border border-black px-[21px] py-[8px] cursor-pointer">
        <span className="absolute inset-0 -translate-x-full bg-black transition-transform duration-500 ease-out group-hover:translate-x-0" />
        <span className="relative text-[10px] tracking-[0.2em] text-black transition-colors duration-500 group-hover:text-white" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          ADD TO CART
        </span>
      </button>
    ),
    code: `<button className="group relative overflow-hidden border border-black px-[21px] py-[8px]">
  <span className="absolute inset-0 -translate-x-full bg-black transition-transform duration-500 ease-out group-hover:translate-x-0" />
  <span className="relative tracking-[0.2em] text-black transition-colors duration-500 group-hover:text-white">
    ADD TO CART
  </span>
</button>`,
  },
  {
    name: 'SKELETON',
    usage: '商品カードの読込プレースホルダー。微かな光が流れる。',
    render: (
      <div className="w-[144px]">
        <div className="relative h-[89px] overflow-hidden bg-black/[0.05]">
          <span className="absolute inset-y-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/60 to-transparent animate-[sheen_1.8s_linear_infinite]" />
        </div>
        <div className="relative mt-[8px] h-[8px] w-3/4 overflow-hidden bg-black/[0.05]">
          <span className="absolute inset-y-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/60 to-transparent animate-[sheen_1.8s_linear_infinite]" />
        </div>
        <div className="relative mt-[5px] h-[8px] w-1/2 overflow-hidden bg-black/[0.05]">
          <span className="absolute inset-y-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/60 to-transparent animate-[sheen_1.8s_linear_infinite]" />
        </div>
      </div>
    ),
    code: `<div className="relative h-[89px] overflow-hidden bg-black/[0.05]">
  <span className="absolute inset-y-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/60 to-transparent animate-[sheen_1.8s_linear_infinite]" />
</div>

/* globals.css or style tag */
@keyframes sheen {
  0% { transform: translateX(-100%) skewX(-12deg); }
  100% { transform: translateX(300%) skewX(-12deg); }
}`,
  },
  {
    name: 'MARQUEE',
    usage: 'セクション区切り・プロモ帯。ブランド名が静かに流れる。',
    render: (
      <div className="w-full overflow-hidden border-y border-black/10 py-[8px]">
        <div className="flex whitespace-nowrap animate-[hScroll_18s_linear_infinite]">
          {[0, 1, 2].map((i) => (
            <span key={i} className="mx-[34px] text-[12px] tracking-[0.3em] text-black/40" style={{ fontFamily: 'Didot, serif' }}>
              {brandName}
            </span>
          ))}
        </div>
      </div>
    ),
    code: `<div className="overflow-hidden border-y border-black/10 py-[8px]">
  <div className="flex whitespace-nowrap animate-[hScroll_18s_linear_infinite]">
    {[0, 1, 2].map((i) => (
      <span key={i} className="mx-[34px] tracking-[0.3em] text-black/40">
        Le Fil des Heures
      </span>
    ))}
  </div>
</div>

/* globals.css or style tag */
@keyframes hScroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(-33.33%); }
}`,
  },
  {
    name: 'MASK LINES',
    usage: '見出し・コピーの表示。行ごとに下から立ち上がる。',
    render: (
      <div className="flex flex-col items-center">
        {['Le Fil', 'des Heures'].map((line, i) => (
          <div key={line} className="overflow-hidden">
            <span
              className="block text-[14px] tracking-wider text-black animate-[slideUp_3s_ease-out_infinite]"
              style={{ fontFamily: 'Didot, serif', animationDelay: `${i * 250}ms` }}
            >
              {line}
            </span>
          </div>
        ))}
      </div>
    ),
    code: `{['Le Fil', 'des Heures'].map((line, i) => (
  <div key={line} className="overflow-hidden">
    <span
      className="block animate-[slideUp_1.2s_ease-out_both]"
      style={{ fontFamily: 'Didot, serif', animationDelay: \`\${i * 250}ms\` }}
    >
      {line}
    </span>
  </div>
))}

/* globals.css or style tag（デモはループ、本番は both で1回） */
@keyframes slideUp {
  0% { transform: translateY(100%); opacity: 0; }
  50% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(0); opacity: 1; }
}`,
  },
];

export default function ContentMotionIdeas() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-[21px]">
      {patterns.map((p) => (
        <div key={p.name} className="flex flex-col border border-black/10 bg-white">
          <div className="flex items-center justify-center h-[160px] px-[21px]">
            {p.render}
          </div>
          <div className="border-t border-black/5 px-[21px] py-[13px]">
            <p className="text-[10px] tracking-[0.2em] text-black/60" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {p.name}
            </p>
            <p className="mt-[5px] text-[10px] text-black/40 leading-[1.7]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              {p.usage}
            </p>
            <CodeBlock code={p.code} label={p.name} />
          </div>
        </div>
      ))}
    </div>
  );
}
