'use client';

import { useState, ReactNode } from 'react';

interface HoverScaleProps {
  children: ReactNode;
  scale?: number;
  duration?: number;
  className?: string;
}

export default function HoverScale({
  children,
  scale = 1.02,
  duration = 300,
  className = '',
}: HoverScaleProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={className}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        transform: isHovered ? `scale(${scale})` : 'scale(1)',
        transition: `transform ${duration}ms cubic-bezier(0.25, 0.1, 0.25, 1)`,
        willChange: 'transform',
        cursor: 'pointer',
      }}
    >
      {children}
    </div>
  );
}
