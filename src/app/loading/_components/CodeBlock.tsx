"use client";

import { useState } from "react";

// label は呼び出し側の記述互換のため型に残すが、本文では使用しない。
export default function CodeBlock({ code }: { code: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-3.25">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.25 text-2.5 text-black/30 tracking-[0.15em] hover:text-black/60 transition-colors cursor-pointer"
        style={{ fontFamily: "acumin-pro, sans-serif" }}
      >
        <i
          className={`ri-code-line w-3 h-3 flex items-center justify-center`}
        ></i>
        {open ? "HIDE CODE" : "SHOW .TSX CODE"}
      </button>

      {open && (
        <div className="mt-2 bg-black/3 border border-black/10 p-3.25 relative group">
          <button
            onClick={handleCopy}
            className="absolute top-1.25 right-1.25 w-8.5 h-8.5 flex items-center justify-center bg-white border border-black/10 hover:border-black/30 transition-colors cursor-pointer z-10"
            title="Copy"
          >
            <i
              className={`${copied ? "ri-check-line" : "ri-file-copy-line"} w-4 h-4 flex items-center justify-center text-black/60 text-xs`}
            ></i>
          </button>
          <pre
            className="text-2.5 text-black/70 leading-[1.8] whitespace-pre-wrap overflow-x-auto pr-8.5"
            style={{ fontFamily: "monospace" }}
          >
            {code}
          </pre>
          {copied && (
            <span
              className="absolute top-1.25 right-10.5 text-2.5 text-black/50 tracking-wider"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              COPIED
            </span>
          )}
        </div>
      )}
    </div>
  );
}
