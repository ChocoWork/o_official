'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';

interface StaggerChildrenProps {
  children: ReactNode;
  staggerDelay?: number;
  baseDelay?: number;
  duration?: number;
  className?: string;
  childClassName?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  distance?: number;
  once?: boolean;
}

export default function StaggerChildren({
  children,
  staggerDelay = 80,
  baseDelay = 0,
  duration = 500,
  className = '',
  childClassName = '',
  direction = 'up',
  distance = 20,
  once = true,
}: StaggerChildrenProps) {
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
      { threshold: 0.05 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [once]);

  const getTransform = () => {
    switch (direction) {
      case 'up': return `translateY(${distance}px)`;
      case 'down': return `translateY(-${distance}px)`;
      case 'left': return `translateX(${distance}px)`;
      case 'right': return `translateX(-${distance}px)`;
    }
  };

  return (
    <div ref={ref} className={className}>
      {Array.isArray(children) ? children.map((child, i) => (
        <div
          key={i}
          className={childClassName}
          style={{
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translate(0,0)' : getTransform(),
            transition: `opacity ${duration}ms cubic-bezier(0.25,0.1,0.25,1) ${baseDelay + i * staggerDelay}ms, transform ${duration}ms cubic-bezier(0.25,0.1,0.25,1) ${baseDelay + i * staggerDelay}ms`,
            willChange: 'opacity, transform',
          }}
        >
          {child}
        </div>
      )) : (
        <div
          className={childClassName}
          style={{
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'translate(0,0)' : getTransform(),
            transition: `opacity ${duration}ms cubic-bezier(0.25,0.1,0.25,1) ${baseDelay}ms, transform ${duration}ms cubic-bezier(0.25,0.1,0.25,1) ${baseDelay}ms`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
