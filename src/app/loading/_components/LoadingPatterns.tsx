'use client';

import { useState, useEffect } from 'react';
import CodeBlock from './CodeBlock';
import StaggerChildren from '@/components/animations/StaggerChildren';

const patterns = [
  {
    name: 'PULSE',
    render: (
      <div className="relative w-6 h-6">
        <div className="absolute inset-0 bg-black rounded-full animate-ping opacity-20"></div>
        <div className="absolute inset-0 bg-black rounded-full"></div>
      </div>
    ),
    code: `<div className="relative w-6 h-6">
  <div className="absolute inset-0 bg-black rounded-full animate-ping opacity-20"></div>
  <div className="absolute inset-0 bg-black rounded-full"></div>
</div>`,
  },
  {
    name: 'SPIN',
    render: (
      <div className="w-8 h-8 border border-black/20 border-t-black rounded-full animate-spin"></div>
    ),
    code: `<div className="w-8 h-8 border border-black/20 border-t-black rounded-full animate-spin"></div>`,
  },
  {
    name: 'TYPING',
    render: (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
        <div className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
        <div className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
      </div>
    ),
    code: `<div className="flex items-center gap-2">
  <div className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
  <div className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
  <div className="w-2 h-2 bg-black rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
</div>`,
  },
  {
    name: 'BREATHE',
    render: (
      <div className="relative flex items-center justify-center w-12 h-12">
        <div className="absolute inset-0 border border-black rounded-full animate-ping opacity-10"></div>
        <div className="w-4 h-4 bg-black rounded-full animate-pulse"></div>
      </div>
    ),
    code: `<div className="relative flex items-center justify-center w-12 h-12">
  <div className="absolute inset-0 border border-black rounded-full animate-ping opacity-10"></div>
  <div className="w-4 h-4 bg-black rounded-full animate-pulse"></div>
</div>`,
  },
  {
    name: 'LINEAR',
    render: (
      <div className="w-24 h-px bg-black/10 relative overflow-hidden">
        <div className="absolute inset-y-0 left-0 w-8 bg-black animate-[slide_1.5s_ease-in-out_infinite]"></div>
      </div>
    ),
    code: `<div className="w-24 h-px bg-black/10 relative overflow-hidden">
  <div className="absolute inset-y-0 left-0 w-8 bg-black animate-[slide_1.5s_ease-in-out_infinite]"></div>
</div>

/* globals.css or style tag */
@keyframes slide {
  0% { left: -32px; }
  100% { left: 100%; }
}`,
  },
  {
    name: 'SHIMMER',
    render: (
      <div className="relative overflow-hidden">
        <span className="text-sm tracking-widest text-black/20" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
        <span className="absolute inset-0 text-sm tracking-widest text-black animate-[shimmer_2s_linear_infinite]" style={{ fontFamily: 'Didot, serif' }}>Loading</span>
      </div>
    ),
    code: `<div className="relative overflow-hidden">
  <span className="text-sm tracking-widest text-black/20">Loading</span>
  <span className="absolute inset-0 text-sm tracking-widest text-black animate-[shimmer_2s_linear_infinite]">Loading</span>
</div>

/* globals.css or style tag */
@keyframes shimmer {
  0% { clip-path: inset(0 100% 0 0); }
  50% { clip-path: inset(0 0 0 0); }
  100% { clip-path: inset(0 100% 0 0); }
}`,
  },
  {
    name: 'SQUARE',
    render: (
      <div className="w-5 h-5 border border-black animate-[spin_2s_linear_infinite]"></div>
    ),
    code: `<div className="w-5 h-5 border border-black animate-[spin_2s_linear_infinite]"></div>`,
  },
  {
    name: 'BARS',
    render: (
      <div className="flex items-center gap-1 h-6">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="w-px h-full bg-black animate-[fadeUp_1s_ease-in-out_infinite]" style={{ animationDelay: `${i * 100}ms` }}></div>
        ))}
      </div>
    ),
    code: `<div className="flex items-center gap-1 h-6">
  {[0, 1, 2, 3, 4].map((i) => (
    <div key={i}
      className="w-px h-full bg-black animate-[fadeUp_1s_ease-in-out_infinite]"
      style={{ animationDelay: \`\${i * 100}ms\` }}
    ></div>
  ))}
</div>

/* globals.css or style tag */
@keyframes fadeUp {
  0%, 100% { transform: scaleY(0.3); opacity: 0.3; }
  50% { transform: scaleY(1); opacity: 1; }
}`,
  },
  {
    name: 'DOUBLE',
    render: (
      <div className="relative w-10 h-10">
        <div className="absolute inset-0 border border-black rounded-full animate-[spin_2s_linear_infinite]"></div>
        <div className="absolute inset-2 border border-black/40 rounded-full animate-[spin_1.5s_linear_infinite_reverse]"></div>
      </div>
    ),
    code: `<div className="relative w-10 h-10">
  <div className="absolute inset-0 border border-black rounded-full animate-[spin_2s_linear_infinite]"></div>
  <div className="absolute inset-2 border border-black/40 rounded-full animate-[spin_1.5s_linear_infinite_reverse]"></div>
</div>`,
  },
  {
    name: 'ORBIT',
    render: (
      <div className="relative w-10 h-10 animate-spin" style={{ animationDuration: '3s' }}>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-black rounded-full"></div>
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-black/40 rounded-full"></div>
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-black/60 rounded-full"></div>
      </div>
    ),
    code: `<div className="relative w-10 h-10 animate-spin" style={{ animationDuration: '3s' }}>
  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-black rounded-full"></div>
  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-black/40 rounded-full"></div>
  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-black/60 rounded-full"></div>
</div>`,
  },
  {
    name: 'SCALE',
    render: (
      <div className="w-4 h-4 bg-black rounded-full animate-[scalePulse_1.5s_ease-in-out_infinite]"></div>
    ),
    code: `<div className="w-4 h-4 bg-black rounded-full animate-[scalePulse_1.5s_ease-in-out_infinite]"></div>

/* globals.css or style tag */
@keyframes scalePulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(2); opacity: 0.3; }
}`,
  },
  {
    name: 'WAVE',
    render: (
      <div className="flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-6 h-px bg-black animate-[wave_1.2s_ease-in-out_infinite]" style={{ animationDelay: `${i * 150}ms` }}></div>
        ))}
      </div>
    ),
    code: `<div className="flex items-center gap-2">
  {[0, 1, 2].map((i) => (
    <div key={i}
      className="w-6 h-px bg-black animate-[wave_1.2s_ease-in-out_infinite]"
      style={{ animationDelay: \`\${i * 150}ms\` }}
    ></div>
  ))}
</div>

/* globals.css or style tag */
@keyframes wave {
  0%, 100% { transform: scaleX(0.3); opacity: 0.3; }
  50% { transform: scaleX(1); opacity: 1; }
}`,
  },
  {
    name: 'CLOCK',
    render: (
      <div className="relative w-10 h-10 rounded-full border border-black/20">
        <div className="absolute top-1/2 left-1/2 w-px h-4 bg-black origin-bottom -translate-x-1/2 -translate-y-full animate-[sweep_1.5s_linear_infinite]"></div>
        <div className="absolute top-1/2 left-1/2 w-4 h-px bg-black origin-left -translate-y-1/2 -translate-x-1/2 animate-[sweep_3s_linear_infinite]"></div>
      </div>
    ),
    code: `<div className="relative w-10 h-10 rounded-full border border-black/20">
  <div className="absolute top-1/2 left-1/2 w-px h-4 bg-black origin-bottom -translate-x-1/2 -translate-y-full animate-[sweep_1.5s_linear_infinite]"></div>
  <div className="absolute top-1/2 left-1/2 w-4 h-px bg-black origin-left -translate-y-1/2 -translate-x-1/2 animate-[sweep_3s_linear_infinite]"></div>
</div>

/* globals.css or style tag */
@keyframes sweep {
  0% { transform: translate(-50%, -50%) rotate(0deg); }
  100% { transform: translate(-50%, -50%) rotate(360deg); }
}`,
  },
  {
    name: 'ELASTIC',
    render: (
      <div className="relative w-16 h-4">
        <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-black rounded-full animate-[elastic_1.5s_ease-in-out_infinite]"></div>
      </div>
    ),
    code: `<div className="relative w-16 h-4">
  <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-black rounded-full animate-[elastic_1.5s_ease-in-out_infinite]"></div>
</div>

/* globals.css or style tag */
@keyframes elastic {
  0% { left: 0; }
  50% { left: calc(100% - 12px); }
  100% { left: 0; }
}`,
  },
  {
    name: 'RIPPLE',
    render: (
      <div className="relative w-10 h-10">
        {[0, 1, 2].map((i) => (
          <div key={i} className="absolute inset-0 border border-black rounded-full animate-[fadeRing_2s_ease-out_infinite]" style={{ animationDelay: `${i * 400}ms` }}></div>
        ))}
      </div>
    ),
    code: `<div className="relative w-10 h-10">
  {[0, 1, 2].map((i) => (
    <div key={i}
      className="absolute inset-0 border border-black rounded-full animate-[fadeRing_2s_ease-out_infinite]"
      style={{ animationDelay: \`\${i * 400}ms\` }}
    ></div>
  ))}
</div>

/* globals.css or style tag */
@keyframes fadeRing {
  0% { transform: scale(0.5); opacity: 1; }
  100% { transform: scale(1.5); opacity: 0; }
}`,
  },
  {
    name: 'STROKE',
    render: (
      <svg className="w-10 h-10" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="black" strokeWidth="1" strokeDasharray="100" strokeDashoffset="100" className="animate-[draw_2s_linear_infinite]" />
      </svg>
    ),
    code: `<svg className="w-10 h-10" viewBox="0 0 40 40">
  <circle cx="20" cy="20" r="16" fill="none" stroke="black"
    strokeWidth="1" strokeDasharray="100"
    strokeDashoffset="100"
    className="animate-[draw_2s_linear_infinite]" />
</svg>

/* globals.css or style tag */
@keyframes draw {
  0% { stroke-dashoffset: 100; }
  50% { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -100; }
}`,
  },
];

export default function LoadingPatterns() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <StaggerChildren
      staggerDelay={60}
      baseDelay={100}
      duration={400}
      direction="up"
      distance={16}
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[21px]"
    >
      {patterns.map((p) => (
        <div key={p.name} className="flex flex-col items-center justify-center py-[34px] px-[21px] bg-white border border-black/10">
          {p.render}
          <p className="mt-[21px] text-[10px] tracking-[0.2em] text-black/30" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            {p.name}
          </p>
          <CodeBlock code={p.code} label={p.name} />
        </div>
      ))}
    </StaggerChildren>
  );
}