import React from 'react';

// 軽量 Markdown レンダラー（記事本文用）。
// 対応: 見出し(#/##/###)、箇条書き(-,*,+)、画像(![alt](url))、リンク([text](url))、
//       強調(**bold** / *italic*)、段落。生 HTML は描画しないため XSS 安全（JSX のみ生成）。

const INLINE_PATTERN =
  /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;

function parseInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const key = `${keyPrefix}-${i}`;
    if (match[1] !== undefined && match[2] !== undefined) {
      // 画像（外部URLも含むため最適化なしの img で安全に描画）
      // eslint-disable-next-line @next/next/no-img-element
      nodes.push(<img key={key} src={match[2]} alt={match[1]} loading="lazy" className="my-5 w-full h-auto" />);
    } else if (match[3] !== undefined && match[4] !== undefined) {
      const href = match[4];
      const external = /^https?:\/\//.test(href);
      nodes.push(
        <a
          key={key}
          href={href}
          className="underline underline-offset-4 hover:text-black transition-colors"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {match[3]}
        </a>,
      );
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(<strong key={key} className="text-black font-medium">{match[5] ?? match[6]}</strong>);
    } else if (match[7] !== undefined || match[8] !== undefined) {
      nodes.push(<em key={key}>{match[7] ?? match[8]}</em>);
    }
    lastIndex = INLINE_PATTERN.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

export function ArticleBody({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ');
    blocks.push(
      <p
        key={`p-${key++}`}
        className="text-[#474747] leading-[1.8] mb-5 sm:mb-7"
        style={{ fontSize: 'var(--lk-size-md)' }}
      >
        {parseInline(text, `p-${key}`)}
      </p>,
    );
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    blocks.push(
      <ul key={`ul-${key++}`} className="list-disc pl-5 mb-5 sm:mb-7 space-y-2 text-[#474747]" style={{ fontSize: 'var(--lk-size-md)' }}>
        {items.map((item, idx) => (
          <li key={idx} className="leading-[1.8]">{parseInline(item, `li-${key}-${idx}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1) {
        blocks.push(<h2 key={`h-${key++}`} className="text-black mt-8 mb-4" style={{ fontSize: 'var(--lk-size-xl)' }}>{parseInline(text, `h-${key}`)}</h2>);
      } else if (level === 2) {
        blocks.push(<h3 key={`h-${key++}`} className="text-black mt-7 mb-3" style={{ fontSize: 'var(--lk-size-lg)' }}>{parseInline(text, `h-${key}`)}</h3>);
      } else {
        blocks.push(<h4 key={`h-${key++}`} className="text-black mt-6 mb-3" style={{ fontSize: 'var(--lk-size-md)' }}>{parseInline(text, `h-${key}`)}</h4>);
      }
      continue;
    }

    const listItem = /^[-*+]\s+(.*)$/.exec(line.trim());
    if (listItem) {
      flushParagraph();
      list.push(listItem[1]);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return <>{blocks}</>;
}
