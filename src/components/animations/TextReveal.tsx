'use client';

import { useEffect, useRef, useState } from 'react';

interface TextRevealProps {
  text: string;
  className?: string;
  delay?: number;
  stagger?: number;
  once?: boolean;
}

export default function TextReveal({
  text,
  className = '',
  delay = 0,
  stagger = 30,
  once = true,
}: TextRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

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

  return (
    <div ref={ref} className={className}>
      {text.split('').map((char, i) => (
        <span
          key={i}
          style={{
            display: 'inline-block',
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
            transition: `opacity 0.4s cubic-bezier(0.25,0.1,0.25,1) ${delay + i * stagger}ms, transform 0.4s cubic-bezier(0.25,0.1,0.25,1) ${delay + i * stagger}ms`,
            willChange: 'opacity, transform',
          }}
        >
          {char === ' ' ? ' ' : char}
        </span>
      ))}
    </div>
  );
}
