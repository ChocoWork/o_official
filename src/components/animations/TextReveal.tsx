'use client';

import { useEffect, useRef, useState, type Ref } from 'react';

interface TextRevealProps {
  text: string;
  /** 描画するタグ。見出しに使う場合は h1 などを指定する（div は h1 の内側に置けない） */
  as?: 'div' | 'h1' | 'h2' | 'h3' | 'p' | 'span';
  className?: string;
  delay?: number;
  stagger?: number;
  once?: boolean;
}

export default function TextReveal({
  text,
  as: Tag = 'div',
  className = '',
  delay = 0,
  stagger = 30,
  once = true,
}: TextRevealProps) {
  const ref = useRef<HTMLElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(query.matches);
    const onChange = () => setReduceMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          if (once) observer.unobserve(el);
        } else if (!once) {
          setIsVisible(false);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [once]);

  // 1文字ずつの span をそのまま読み上げると1文字ずつ綴られてしまうため、
  // アクセシブル名は aria-label で元の文字列を与え、span 側は木から外す。
  const shown = isVisible || reduceMotion;

  return (
    <Tag ref={ref as Ref<HTMLDivElement>} className={className} aria-label={text}>
      {text.split('').map((char, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            display: 'inline-block',
            opacity: shown ? 1 : 0,
            transform: shown ? 'translateY(0)' : 'translateY(100%)',
            transition: reduceMotion
              ? 'none'
              : `opacity 0.4s cubic-bezier(0.25,0.1,0.25,1) ${delay + i * stagger}ms, transform 0.4s cubic-bezier(0.25,0.1,0.25,1) ${delay + i * stagger}ms`,
            willChange: 'opacity, transform',
          }}
        >
          {char === ' ' ? ' ' : char}
        </span>
      ))}
    </Tag>
  );
}
