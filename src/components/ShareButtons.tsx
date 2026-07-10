'use client';

import { useState } from 'react';

type ShareButtonsProps = {
  url: string;
  title: string;
};

export function ShareButtons({ url, title }: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);

  const shareText = encodeURIComponent(title);
  const shareUrl = encodeURIComponent(url);
  const xHref = `https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}`;
  const lineHref = `https://social-plugins.line.me/lineit/share?url=${shareUrl}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境では何もしない
    }
  };

  const iconClass =
    'w-9 h-9 flex items-center justify-center border border-black/15 text-[#474747] hover:bg-black hover:text-white hover:border-black transition-colors';

  return (
    <div className="flex items-center gap-3">
      <span
        className="font-brand tracking-widest text-[#474747]"
        style={{ fontSize: 'var(--lk-size-4xs)' }}
      >
        SHARE
      </span>
      <a href={xHref} target="_blank" rel="noopener noreferrer" aria-label="X でシェア" className={iconClass}>
        <i className="ri-twitter-x-line" aria-hidden="true" />
      </a>
      <a href={lineHref} target="_blank" rel="noopener noreferrer" aria-label="LINE でシェア" className={iconClass}>
        <i className="ri-line-line" aria-hidden="true" />
      </a>
      <button type="button" onClick={handleCopy} aria-label="リンクをコピー" className={iconClass}>
        <i className={copied ? 'ri-check-line' : 'ri-links-line'} aria-hidden="true" />
      </button>
      <span role="status" aria-live="polite" className="text-[#474747]" style={{ fontSize: 'var(--lk-size-4xs)' }}>
        {copied ? 'コピーしました' : ''}
      </span>
    </div>
  );
}
