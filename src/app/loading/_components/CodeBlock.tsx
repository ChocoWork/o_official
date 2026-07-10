'use client';

import { useState } from 'react';

export default function CodeBlock({ code, label }: { code: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-[13px]">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-[5px] text-[10px] text-black/30 tracking-[0.15em] hover:text-black/60 transition-colors cursor-pointer"
        style={{ fontFamily: 'acumin-pro, sans-serif' }}
      >
        <i className={`ri-code-line w-3 h-3 flex items-center justify-center`}></i>
        {open ? 'HIDE CODE' : 'SHOW .TSX CODE'}
      </button>

      {open && (
        <div className="mt-[8px] bg-black/[0.03] border border-black/10 p-[13px] relative group">
          <button
            onClick={handleCopy}
            className="absolute top-[5px] right-[5px] w-[34px] h-[34px] flex items-center justify-center bg-white border border-black/10 hover:border-black/30 transition-colors cursor-pointer z-10"
            title="Copy"
          >
            <i className={`${copied ? 'ri-check-line' : 'ri-file-copy-line'} w-4 h-4 flex items-center justify-center text-black/60 text-xs`}></i>
          </button>
          <pre className="text-[10px] text-black/70 leading-[1.8] whitespace-pre-wrap overflow-x-auto pr-[34px]" style={{ fontFamily: 'monospace' }}>
            {code}
          </pre>
          {copied && (
            <span className="absolute top-[5px] right-[42px] text-[10px] text-black/50 tracking-wider" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
              COPIED
            </span>
          )}
        </div>
      )}
    </div>
  );
}