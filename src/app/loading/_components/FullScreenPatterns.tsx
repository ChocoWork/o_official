'use client';

import { useState, useEffect } from 'react';

export default function FullScreenPatterns() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">

      {/* 1. Center Pulse — 中央から広がる円 */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute w-40 h-40 rounded-full border border-white/20 animate-[centerPulse_2s_ease-out_infinite]" />
        <div className="absolute w-40 h-40 rounded-full border border-white/20 animate-[centerPulse_2s_ease-out_infinite]" style={{ animationDelay: '0.6s' }} />
        <div className="absolute w-40 h-40 rounded-full border border-white/20 animate-[centerPulse_2s_ease-out_infinite]" style={{ animationDelay: '1.2s' }} />
        <div className="w-3 h-3 bg-white rounded-full" />
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          CENTER PULSE
        </p>
      </div>

      {/* 2. Split Slide — 画面分割スライド */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex">
          <div className="w-1/2 h-full bg-black animate-[slideLeft_2s_ease-in-out_infinite_alternate]" />
          <div className="w-1/2 h-full bg-black animate-[slideRight_2s_ease-in-out_infinite_alternate]" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm tracking-widest text-white mix-blend-difference" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        </div>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40 mix-blend-difference" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          SPLIT SLIDE
        </p>
      </div>

      {/* 3. Full Ripple — フルスクリーンリップル */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex items-center justify-center">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="absolute w-96 h-96 rounded-full border border-black/10 animate-[fullRipple_3s_ease-out_infinite]" style={{ animationDelay: `${i * 600}ms` }} />
          ))}
        </div>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          FULL RIPPLE
        </p>
      </div>

      {/* 4. Curtain Open — カーテン開閉 */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-y-0 left-0 w-1/2 bg-white animate-[curtainOpen_2.5s_ease-in-out_infinite_alternate]" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-white animate-[curtainOpen_2.5s_ease-in-out_infinite_alternate]" />
        <span className="text-sm tracking-widest text-black" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          CURTAIN
        </p>
      </div>

      {/* 5. Full Spinner — 全画面スピナー */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="w-20 h-20 border border-white/30 border-t-white rounded-full animate-spin" />
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          FULL SPIN
        </p>
      </div>

      {/* 6. Scan Line — スキャニングライン */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl tracking-widest text-white/10" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        </div>
        <div className="absolute w-full h-px bg-white/60 animate-[scanLine_2s_linear_infinite]" />
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          SCAN LINE
        </p>
      </div>

      {/* 7. Dot Grid — ドットグリッドフェード */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="grid grid-cols-8 gap-6">
          {Array.from({ length: 40 }).map((_, i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 bg-black rounded-full animate-[dotFade_2s_ease-in-out_infinite]"
              style={{ animationDelay: `${(i % 8) * 100 + Math.floor(i / 8) * 100}ms` }}
            />
          ))}
        </div>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          DOT GRID
        </p>
      </div>

      {/* 8. Monolith — 中央モノリス */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="w-4 h-32 bg-white animate-[monolith_2s_ease-in-out_infinite]" />
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          MONOLITH
        </p>
      </div>

      {/* 9. Circle Wipe — 円形ワイプ */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute w-0 h-0 bg-white rounded-full animate-[circleWipe_2.5s_ease-in-out_infinite_alternate]" />
        <span className="relative text-sm tracking-widest text-white mix-blend-difference" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40 mix-blend-difference" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          CIRCLE WIPE
        </p>
      </div>

      {/* 10. Bars Reveal — 水平バーリビール */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex flex-col">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex-1 bg-black animate-[barReveal_2s_ease-in-out_infinite_alternate]" style={{ animationDelay: `${i * 200}ms` }} />
          ))}
        </div>
        <span className="relative text-sm tracking-widest text-white mix-blend-difference" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40 mix-blend-difference" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          BARS REVEAL
        </p>
      </div>

      {/* 11. Progress Arc — 円弧プログレス */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="45" fill="none" stroke="black" strokeWidth="1" opacity="0.1" />
          <circle cx="50" cy="50" r="45" fill="none" stroke="black" strokeWidth="1" strokeDasharray="283" strokeDashoffset="283" className="animate-[arcProgress_2s_ease-in-out_infinite]" />
        </svg>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          PROGRESS ARC
        </p>
      </div>

      {/* 12. Fade Overlay — オーバーレイフェード */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 bg-black animate-[fadeOverlay_3s_ease-in-out_infinite]" />
        <span className="relative text-sm tracking-widest text-white" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          FADE OVERLAY
        </p>
      </div>

      {/* 13. Concentric — 同心円 */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="relative w-48 h-48">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="absolute inset-0 border border-white/20 rounded-full animate-[concentric_3s_ease-in-out_infinite]" style={{ animationDelay: `${i * 300}ms`, transform: `scale(${1 - i * 0.15})` }} />
          ))}
        </div>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          CONCENTRIC
        </p>
      </div>

      {/* 14. Shutter — シャッター */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="absolute inset-0 flex">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex-1 bg-black animate-[shutter_2s_ease-in-out_infinite_alternate]" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
        <span className="relative text-sm tracking-widest text-white mix-blend-difference" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40 mix-blend-difference" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          SHUTTER
        </p>
      </div>

      {/* 15. Grid Flip — グリッドフリップ */}
      <div className="relative aspect-video bg-black flex items-center justify-center overflow-hidden border border-black/10">
        <div className="grid grid-cols-6 gap-1">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="w-8 h-8 bg-white/0 border border-white/10 animate-[gridFlip_2s_ease-in-out_infinite]" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-white/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          GRID FLIP
        </p>
      </div>

      {/* 16. Diamond — ダイヤモンド拡大 */}
      <div className="relative aspect-video bg-white flex items-center justify-center overflow-hidden border border-black/10">
        <div className="w-32 h-32 border border-black rotate-45 animate-[diamond_2s_ease-in-out_infinite]" />
        <div className="absolute w-16 h-16 border border-black/30 rotate-45 animate-[diamond_2s_ease-in-out_infinite]" style={{ animationDelay: '0.5s' }} />
        <p className="absolute bottom-6 left-6 text-xs tracking-widest text-black/40" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
          DIAMOND
        </p>
      </div>

    </div>
  );
}