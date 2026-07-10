// ----------------- LOADING デザインギャラリー（Admin 専用） -----------------
'use client';

import { useLogin } from '@/contexts/LoginContext';
import LoadingPatterns from './_components/LoadingPatterns';
import FullScreenPatterns from './_components/FullScreenPatterns';
import BrandNamePatterns from './_components/BrandNamePatterns';
import AnimationShowcase from './_components/AnimationShowcase';
import ContentMotionIdeas from './_components/ContentMotionIdeas';

export default function LoadingPage() {
  const { isLoggedIn, isAuthResolved, userRole } = useLogin();

  if (!isAuthResolved) {
    return (
      <div className="element-width">
        <p className="text-sm text-[#474747] font-acumin">読み込み中...</p>
      </div>
    );
  }

  if (!isLoggedIn || userRole !== 'admin') {
    return (
      <div className="element-width">
        <h1 className="mb-4">アクセス権限がありません</h1>
        <p className="text-sm text-[#474747] font-acumin">このページは Admin のみ利用できます。</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <style>{`
        @keyframes slide {
          0% { left: -32px; }
          100% { left: 100%; }
        }
        @keyframes shimmer {
          0% { clip-path: inset(0 100% 0 0); }
          50% { clip-path: inset(0 0 0 0); }
          100% { clip-path: inset(0 100% 0 0); }
        }
        @keyframes fadeUp {
          0%, 100% { transform: scaleY(0.3); opacity: 0.3; }
          50% { transform: scaleY(1); opacity: 1; }
        }
        @keyframes scalePulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(2); opacity: 0.3; }
        }
        @keyframes wave {
          0%, 100% { transform: scaleX(0.3); opacity: 0.3; }
          50% { transform: scaleX(1); opacity: 1; }
        }
        @keyframes sweep {
          0% { transform: translate(-50%, -50%) rotate(0deg); }
          100% { transform: translate(-50%, -50%) rotate(360deg); }
        }
        @keyframes elastic {
          0% { left: 0; }
          50% { left: calc(100% - 12px); }
          100% { left: 0; }
        }
        @keyframes fadeRing {
          0% { transform: scale(0.5); opacity: 1; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        @keyframes draw {
          0% { stroke-dashoffset: 100; }
          50% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -100; }
        }

        /* Full Screen Patterns */
        @keyframes centerPulse {
          0% { transform: scale(0.5); opacity: 0; }
          50% { opacity: 1; }
          100% { transform: scale(1.5); opacity: 0; }
        }
        @keyframes slideLeft {
          0% { transform: translateX(0); }
          100% { transform: translateX(-100%); }
        }
        @keyframes slideRight {
          0% { transform: translateX(0); }
          100% { transform: translateX(100%); }
        }
        @keyframes fullRipple {
          0% { transform: scale(0.2); opacity: 1; }
          100% { transform: scale(1); opacity: 0; }
        }
        @keyframes curtainOpen {
          0% { width: 50%; }
          100% { width: 0; }
        }
        @keyframes scanLine {
          0% { top: 0; }
          100% { top: 100%; }
        }
        @keyframes dotFade {
          0%, 100% { opacity: 0.1; }
          50% { opacity: 1; }
        }
        @keyframes monolith {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(1.3); }
        }
        @keyframes circleWipe {
          0% { width: 0; height: 0; opacity: 1; }
          100% { width: 300%; height: 300%; opacity: 1; }
        }
        @keyframes barReveal {
          0% { transform: scaleX(0); }
          100% { transform: scaleX(1); }
        }
        @keyframes arcProgress {
          0% { stroke-dashoffset: 283; }
          50% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -283; }
        }
        @keyframes fadeOverlay {
          0%, 100% { opacity: 0; }
          50% { opacity: 1; }
        }
        @keyframes concentric {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 1; }
        }
        @keyframes shutter {
          0% { transform: scaleY(0); }
          100% { transform: scaleY(1); }
        }
        @keyframes gridFlip {
          0%, 100% { background-color: transparent; }
          50% { background-color: rgba(255,255,255,0.6); }
        }
        @keyframes diamond {
          0%, 100% { transform: scale(1) rotate(45deg); opacity: 1; }
          50% { transform: scale(0.5) rotate(45deg); opacity: 0.3; }
        }

        /* Brand Name Patterns */
        @keyframes letterFade {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 1; }
        }
        @keyframes brandPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.05); }
        }
        @keyframes brandShimmer {
          0% { clip-path: inset(0 100% 0 0); }
          50% { clip-path: inset(0 0 0 0); }
          100% { clip-path: inset(0 0 0 100%); }
        }
        @keyframes typingReveal {
          0% { width: 0; }
          50% { width: 100%; }
          100% { width: 100%; }
        }
        @keyframes strokeDraw {
          0%, 100% { stroke-dashoffset: 400; }
          50% { stroke-dashoffset: 0; }
        }
        @keyframes bounceLetter {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-12px); }
        }
        @keyframes letterSpace {
          0%, 100% { letter-spacing: 0.1em; }
          50% { letter-spacing: 0.3em; }
        }
        @keyframes opacityWave {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 1; }
        }
        @keyframes blurFocus {
          0%, 100% { filter: blur(0px); opacity: 1; }
          50% { filter: blur(4px); opacity: 0.5; }
        }
        @keyframes slideUp {
          0% { transform: translateY(100%); opacity: 0; }
          50% { transform: translateY(0); opacity: 1; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes hScroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-33.33%); }
        }
        @keyframes stackReveal {
          0% { transform: translateY(100%); opacity: 0; }
          50% { transform: translateY(0); opacity: 1; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes glitch {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-2px); }
          40% { transform: translateX(2px); }
          60% { transform: translateX(-1px); }
          80% { transform: translateX(1px); }
        }
        @keyframes mirrorFlip {
          0%, 100% { transform: rotateY(0deg); }
          50% { transform: rotateY(180deg); }
        }
        @keyframes rotateWord {
          0% { transform: rotateY(0deg) rotateX(0deg); }
          100% { transform: rotateY(360deg) rotateX(360deg); }
        }
        @keyframes underlineDraw {
          0% { width: 0; }
          50% { width: 100%; }
          100% { width: 100%; }
        }

        /* Content Motion */
        @keyframes threadDraw {
          0% { transform: scaleY(0); }
          55% { transform: scaleY(1); }
          100% { transform: scaleY(1); }
        }
        @keyframes imageWipe {
          0% { clip-path: inset(0 100% 0 0); }
          55% { clip-path: inset(0 0 0 0); }
          85% { clip-path: inset(0 0 0 0); }
          100% { clip-path: inset(0 100% 0 0); }
        }
        @keyframes sheen {
          0% { transform: translateX(-100%) skewX(-12deg); }
          100% { transform: translateX(300%) skewX(-12deg); }
        }
      `}</style>

      <section className="px-5 md:px-8 lg:px-[34px] xl:px-[55px] py-[55px]">
        <div className="max-w-[1280px] mx-auto">

          <div className="mb-[55px]">
            <h1 className="text-[22px] text-black tracking-tight mb-[13px]" style={{ fontFamily: 'Didot, serif' }}>
              Loading
            </h1>
            <p className="text-[11px] text-black/40 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              ミニマルでモードなローディング表現のコレクション — 各パターン下にコピー可能な .tsx コードを表示
            </p>
          </div>

          {/* Section: Loading Patterns */}
          <div className="mb-[34px]">
            <h2 className="text-[16px] text-black tracking-tight mb-[5px]" style={{ fontFamily: 'Didot, serif' }}>
              Standard
            </h2>
            <p className="text-[10px] text-black/40 tracking-wider mb-[34px]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              ベーシックなローディング表現 — 8パターン
            </p>
          </div>

          <LoadingPatterns />

          {/* Section: Full Screen Patterns */}
          <div className="mt-[89px] mb-[34px]">
            <h2 className="text-[16px] text-black tracking-tight mb-[5px]" style={{ fontFamily: 'Didot, serif' }}>
              Full Screen
            </h2>
            <p className="text-[10px] text-black/40 tracking-wider mb-[34px]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              画面全体を使ったモードなローディング表現 — 16パターン
            </p>
          </div>

          <FullScreenPatterns />

          {/* Section: Animation Components */}
          <div className="mt-[89px] mb-[34px]">
            <h2 className="text-[16px] text-black tracking-tight mb-[5px]" style={{ fontFamily: 'Didot, serif' }}>
              Animation Components
            </h2>
            <p className="text-[10px] text-black/40 tracking-wider mb-[34px]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              全ページで使用できるアニメーションコンポーネント — コピーして各ページで使用可能
            </p>
          </div>

          <AnimationShowcase />

          <div className="mt-[55px] p-[21px] sm:p-[26px] md:p-[34px] border border-black/10 bg-[#fafafa]">
            <p className="text-[11px] sm:text-[12px] text-black/60 leading-[1.8]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              各コンポーネントは <span className="text-black">components/animations/</span> フォルダに配置されています。使用する際はインポートして必要なプロップを設定するだけです。IntersectionObserverを使用しているため、要素が画面に入ったタイミングで自動的にアニメーションが開始されます。
            </p>
          </div>

          {/* Section: Brand Name Patterns */}
          <div className="mt-[89px] mb-[34px]">
            <h2 className="text-[16px] text-black tracking-tight mb-[5px]" style={{ fontFamily: 'Didot, serif' }}>
              Brand Name
            </h2>
            <p className="text-[10px] text-black/40 tracking-wider mb-[34px]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              Le Fil des Heures を使ったブランド表現 — 16パターン
            </p>
          </div>

          <BrandNamePatterns />

          {/* Section: Content Motion */}
          <div className="mt-[89px] mb-[34px]">
            <h2 className="text-[16px] text-black tracking-tight mb-[5px]" style={{ fontFamily: 'Didot, serif' }}>
              Content Motion
            </h2>
            <p className="text-[10px] text-black/40 tracking-wider mb-[34px]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              実コンテンツ（商品・LOOK・見出し・CTA）で使えるモーションアイデア — 8パターン
            </p>
          </div>

          <ContentMotionIdeas />
        </div>
      </section>
    </div>
  );
}
