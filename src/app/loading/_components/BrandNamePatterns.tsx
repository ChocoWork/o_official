'use client';

import { useState, useEffect } from 'react';
import CodeBlock from './CodeBlock';

const brandName = "Le Fil des Heures";
const letters = brandName.split('');

const patterns = [
  {
    name: 'LETTER FADE',
    bg: 'bg-black',
    render: (
      <div className="flex">
        {letters.map((char, i) => (
          <span key={i} className="text-[16px] tracking-wide text-white animate-[letterFade_2s_ease-in-out_infinite]" style={{ fontFamily: 'Didot, serif', animationDelay: `${i * 120}ms` }}>
            {char === ' ' ? '\u00A0' : char}
          </span>
        ))}
      </div>
    ),
    code: `const brandName = "Le Fil des Heures";
const letters = brandName.split('');

<div className="flex">
  {letters.map((char, i) => (
    <span key={i}
      className="text-[16px] tracking-wide text-white animate-[letterFade_2s_ease-in-out_infinite]"
      style={{ fontFamily: 'Didot, serif', animationDelay: \`\${i * 120}ms\` }}>
      {char === ' ' ? '\\u00A0' : char}
    </span>
  ))}
</div>

/* globals.css or style tag */
@keyframes letterFade {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}`,
  },
  {
    name: 'BRAND PULSE',
    bg: 'bg-white',
    render: (
      <span className="text-[18px] tracking-wider text-black animate-[brandPulse_2s_ease-in-out_infinite]" style={{ fontFamily: 'Didot, serif' }}>
        {brandName}
      </span>
    ),
    code: `<span className="text-[18px] tracking-wider text-black animate-[brandPulse_2s_ease-in-out_infinite]"
  style={{ fontFamily: 'Didot, serif' }}>
  Le Fil des Heures
</span>

/* globals.css or style tag */
@keyframes brandPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.05); }
}`,
  },
  {
    name: 'SHIMMER',
    bg: 'bg-black',
    render: (
      <div className="relative">
        <span className="text-[16px] tracking-wider text-white/10" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
        <span className="absolute inset-0 text-[16px] tracking-wider text-white animate-[brandShimmer_2.5s_linear_infinite]" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
      </div>
    ),
    code: `<div className="relative">
  <span className="text-[16px] tracking-wider text-white/10">
    Le Fil des Heures
  </span>
  <span className="absolute inset-0 text-[16px] tracking-wider text-white animate-[brandShimmer_2.5s_linear_infinite]">
    Le Fil des Heures
  </span>
</div>

/* globals.css or style tag */
@keyframes brandShimmer {
  0% { clip-path: inset(0 100% 0 0); }
  50% { clip-path: inset(0 0 0 0); }
  100% { clip-path: inset(0 0 0 100%); }
}`,
  },
  {
    name: 'TYPING REVEAL',
    bg: 'bg-white',
    render: (
      <span className="text-[16px] tracking-wider text-black animate-[typingReveal_3s_steps(17)_infinite] overflow-hidden whitespace-nowrap" style={{ fontFamily: 'Didot, serif' }}>
        {brandName}
      </span>
    ),
    code: `<span className="text-[16px] tracking-wider text-black animate-[typingReveal_3s_steps(17)_infinite] overflow-hidden whitespace-nowrap"
  style={{ fontFamily: 'Didot, serif' }}>
  Le Fil des Heures
</span>

/* globals.css or style tag */
@keyframes typingReveal {
  0% { width: 0; }
  50% { width: 100%; }
  100% { width: 100%; }
}`,
  },
  {
    name: 'STROKE DRAW',
    bg: 'bg-black',
    render: (
      <svg className="w-64 h-12" viewBox="0 0 240 40">
        <text x="120" y="28" textAnchor="middle" fill="none" stroke="white" strokeWidth="0.5" fontSize="16" fontFamily="Didot, serif" className="animate-[strokeDraw_3s_ease-in-out_infinite]" style={{ strokeDasharray: 400, strokeDashoffset: 400 }}>
          {brandName}
        </text>
      </svg>
    ),
    code: `<svg className="w-64 h-12" viewBox="0 0 240 40">
  <text x="120" y="28" textAnchor="middle" fill="none" stroke="white"
    strokeWidth="0.5" fontSize="16" fontFamily="Didot, serif"
    className="animate-[strokeDraw_3s_ease-in-out_infinite]"
    style={{ strokeDasharray: 400, strokeDashoffset: 400 }}>
    Le Fil des Heures
  </text>
</svg>

/* globals.css or style tag */
@keyframes strokeDraw {
  0%, 100% { stroke-dashoffset: 400; }
  50% { stroke-dashoffset: 0; }
}`,
  },
  {
    name: 'BOUNCE',
    bg: 'bg-white',
    render: (
      <div className="flex">
        {letters.map((char, i) => (
          <span key={i} className="text-[16px] tracking-wide text-black animate-[bounceLetter_1.2s_ease-in-out_infinite]" style={{ fontFamily: 'Didot, serif', animationDelay: `${i * 80}ms` }}>
            {char === ' ' ? '\u00A0' : char}
          </span>
        ))}
      </div>
    ),
    code: `const letters = "Le Fil des Heures".split('');

<div className="flex">
  {letters.map((char, i) => (
    <span key={i}
      className="text-[16px] tracking-wide text-black animate-[bounceLetter_1.2s_ease-in-out_infinite]"
      style={{ fontFamily: 'Didot, serif', animationDelay: \`\${i * 80}ms\` }}>
      {char === ' ' ? '\\u00A0' : char}
    </span>
  ))}
</div>

/* globals.css or style tag */
@keyframes bounceLetter {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-12px); }
}`,
  },
  {
    name: 'LETTER SPACE',
    bg: 'bg-black',
    render: (
      <span className="text-[16px] text-white animate-[letterSpace_2s_ease-in-out_infinite]" style={{ fontFamily: 'Didot, serif' }}>
        {brandName}
      </span>
    ),
    code: `<span className="text-[16px] text-white animate-[letterSpace_2s_ease-in-out_infinite]"
  style={{ fontFamily: 'Didot, serif' }}>
  Le Fil des Heures
</span>

/* globals.css or style tag */
@keyframes letterSpace {
  0%, 100% { letter-spacing: 0.1em; }
  50% { letter-spacing: 0.3em; }
}`,
  },
  {
    name: 'OPACITY WAVE',
    bg: 'bg-white',
    render: (
      <div className="flex">
        {letters.map((char, i) => (
          <span key={i} className="text-[16px] tracking-wide text-black animate-[opacityWave_1.5s_ease-in-out_infinite]" style={{ fontFamily: 'Didot, serif', animationDelay: `${i * 100}ms` }}>
            {char === ' ' ? '\u00A0' : char}
          </span>
        ))}
      </div>
    ),
    code: `const letters = "Le Fil des Heures".split('');

<div className="flex">
  {letters.map((char, i) => (
    <span key={i}
      className="text-[16px] tracking-wide text-black animate-[opacityWave_1.5s_ease-in-out_infinite]"
      style={{ fontFamily: 'Didot, serif', animationDelay: \`\${i * 100}ms\` }}>
      {char === ' ' ? '\\u00A0' : char}
    </span>
  ))}
</div>

/* globals.css or style tag */
@keyframes opacityWave {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}`,
  },
  {
    name: 'BLUR FOCUS',
    bg: 'bg-black',
    render: (
      <span className="text-[18px] tracking-wider text-white animate-[blurFocus_2.5s_ease-in-out_infinite]" style={{ fontFamily: 'Didot, serif' }}>
        {brandName}
      </span>
    ),
    code: `<span className="text-[18px] tracking-wider text-white animate-[blurFocus_2.5s_ease-in-out_infinite]"
  style={{ fontFamily: 'Didot, serif' }}>
  Le Fil des Heures
</span>

/* globals.css or style tag */
@keyframes blurFocus {
  0%, 100% { filter: blur(0px); opacity: 1; }
  50% { filter: blur(4px); opacity: 0.5; }
}`,
  },
  {
    name: 'SLIDE UP',
    bg: 'bg-white',
    render: (
      <div className="overflow-hidden h-8">
        <span className="block text-[16px] tracking-wider text-black animate-[slideUp_2s_ease-out_infinite]" style={{ fontFamily: 'Didot, serif' }}>
          {brandName}
        </span>
      </div>
    ),
    code: `<div className="overflow-hidden h-8">
  <span className="block text-[16px] tracking-wider text-black animate-[slideUp_2s_ease-out_infinite]"
    style={{ fontFamily: 'Didot, serif' }}>
    Le Fil des Heures
  </span>
</div>

/* globals.css or style tag */
@keyframes slideUp {
  0% { transform: translateY(100%); opacity: 0; }
  50% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(0); opacity: 1; }
}`,
  },
  {
    name: 'HORIZONTAL SCROLL',
    bg: 'bg-black',
    render: (
      <div className="relative w-full flex items-center justify-center">
        <div className="absolute whitespace-nowrap animate-[hScroll_4s_linear_infinite]" style={{ fontFamily: 'Didot, serif' }}>
          <span className="text-[12px] tracking-widest text-white/20">{brandName}</span>
          <span className="text-[12px] tracking-widest text-white/20 ml-12">{brandName}</span>
          <span className="text-[12px] tracking-widest text-white/20 ml-12">{brandName}</span>
        </div>
        <span className="relative text-[16px] tracking-wider text-white" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
      </div>
    ),
    code: `<div className="relative w-full flex items-center justify-center">
  <div className="absolute whitespace-nowrap animate-[hScroll_4s_linear_infinite]">
    <span className="text-[12px] tracking-widest text-white/20">
      Le Fil des Heures
    </span>
    <span className="text-[12px] tracking-widest text-white/20 ml-12">
      Le Fil des Heures
    </span>
  </div>
  <span className="relative text-[16px] tracking-wider text-white">
    Le Fil des Heures
  </span>
</div>

/* globals.css or style tag */
@keyframes hScroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(-33.33%); }
}`,
  },
  {
    name: 'STACK REVEAL',
    bg: 'bg-white',
    render: (
      <div className="flex flex-col items-center gap-0">
        {"Le Fil des Heures".split(' ').map((word, i) => (
          <div key={i} className="overflow-hidden">
            <span className="block text-[16px] tracking-wider text-black animate-[stackReveal_2s_ease-out_infinite]" style={{ fontFamily: 'Didot', animationDelay: `${i * 200}ms` }}>
              {word}
            </span>
          </div>
        ))}
      </div>
    ),
    code: `<div className="flex flex-col items-center gap-0">
  {"Le Fil des Heures".split(' ').map((word, i) => (
    <div key={i} className="overflow-hidden">
      <span className="block text-[16px] tracking-wider text-black animate-[stackReveal_2s_ease-out_infinite]"
        style={{ fontFamily: 'Didot', animationDelay: \`\${i * 200}ms\` }}>
        {word}
      </span>
    </div>
  ))}
</div>

/* globals.css or style tag */
@keyframes stackReveal {
  0% { transform: translateY(100%); opacity: 0; }
  50% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(0); opacity: 1; }
}`,
  },
  {
    name: 'GLITCH',
    bg: 'bg-black',
    render: (
      <div className="relative">
        <span className="relative text-[16px] tracking-wider text-white" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
        <span className="absolute inset-0 text-[16px] tracking-wider text-white/50 animate-[glitch_2s_linear_infinite]" style={{ fontFamily: 'Didot, serif', clipPath: 'inset(0 0 50% 0)' }}>{brandName}</span>
        <span className="absolute inset-0 text-[16px] tracking-wider text-white/50 animate-[glitch_2s_linear_infinite_reverse]" style={{ fontFamily: 'Didot, serif', clipPath: 'inset(50% 0 0 0)' }}>{brandName}</span>
      </div>
    ),
    code: `<div className="relative">
  <span className="relative text-[16px] tracking-wider text-white">
    Le Fil des Heures
  </span>
  <span className="absolute inset-0 text-[16px] tracking-wider text-white/50 animate-[glitch_2s_linear_infinite]"
    style={{ clipPath: 'inset(0 0 50% 0)' }}>
    Le Fil des Heures
  </span>
  <span className="absolute inset-0 text-[16px] tracking-wider text-white/50 animate-[glitch_2s_linear_infinite_reverse]"
    style={{ clipPath: 'inset(50% 0 0 0)' }}>
    Le Fil des Heures
  </span>
</div>

/* globals.css or style tag */
@keyframes glitch {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-2px); }
  40% { transform: translateX(2px); }
  60% { transform: translateX(-1px); }
  80% { transform: translateX(1px); }
}`,
  },
  {
    name: 'MIRROR FLIP',
    bg: 'bg-white',
    render: (
      <div className="animate-[mirrorFlip_3s_ease-in-out_infinite]" style={{ transformStyle: 'preserve-3d' }}>
        <span className="text-[16px] tracking-wider text-black" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
      </div>
    ),
    code: `<div className="animate-[mirrorFlip_3s_ease-in-out_infinite]"
  style={{ transformStyle: 'preserve-3d' }}>
  <span className="text-[16px] tracking-wider text-black"
    style={{ fontFamily: 'Didot, serif' }}>
    Le Fil des Heures
  </span>
</div>

/* globals.css or style tag */
@keyframes mirrorFlip {
  0%, 100% { transform: rotateY(0deg); }
  50% { transform: rotateY(180deg); }
}`,
  },
  {
    name: 'ROTATE WORD',
    bg: 'bg-black',
    render: (
      <div className="animate-[rotateWord_3s_linear_infinite]" style={{ transformStyle: 'preserve-3d' }}>
        <span className="text-[16px] tracking-wider text-white" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
      </div>
    ),
    code: `<div className="animate-[rotateWord_3s_linear_infinite]"
  style={{ transformStyle: 'preserve-3d' }}>
  <span className="text-[16px] tracking-wider text-white"
    style={{ fontFamily: 'Didot, serif' }}>
    Le Fil des Heures
  </span>
</div>

/* globals.css or style tag */
@keyframes rotateWord {
  0% { transform: rotateY(0deg) rotateX(0deg); }
  100% { transform: rotateY(360deg) rotateX(360deg); }
}`,
  },
  {
    name: 'UNDERLINE DRAW',
    bg: 'bg-white',
    render: (
      <div className="relative">
        <span className="text-[16px] tracking-wider text-black" style={{ fontFamily: 'Didot, serif' }}>{brandName}</span>
        <div className="absolute left-0 bottom-0 h-px bg-black animate-[underlineDraw_2s_ease-in-out_infinite]" />
      </div>
    ),
    code: `<div className="relative">
  <span className="text-[16px] tracking-wider text-black"
    style={{ fontFamily: 'Didot, serif' }}>
    Le Fil des Heures
  </span>
  <div className="absolute left-0 bottom-0 h-px bg-black animate-[underlineDraw_2s_ease-in-out_infinite]" />
</div>

/* globals.css or style tag */
@keyframes underlineDraw {
  0% { width: 0; }
  50% { width: 100%; }
  100% { width: 100%; }
}`,
  },
];

export default function BrandNamePatterns() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-[21px]">
      {patterns.map((p) => (
        <div key={p.name} className={`flex flex-col items-center justify-center aspect-video ${p.bg} border border-black/10 overflow-hidden py-[34px]`}>
          {p.render}
          <p className={`mt-[21px] text-[10px] tracking-[0.2em] ${p.bg === 'bg-black' ? 'text-white/30' : 'text-black/30'}`} style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            {p.name}
          </p>
          <div className="w-full px-[21px] mt-[8px]">
            <CodeBlock code={p.code} label={p.name} />
          </div>
        </div>
      ))}
    </div>
  );
}