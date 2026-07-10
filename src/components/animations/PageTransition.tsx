'use client';

import { useEffect, useState, ReactNode } from 'react';

interface PageTransitionProps {
  children: ReactNode;
  duration?: number;
}

export default function PageTransition({ children, duration = 500 }: PageTransitionProps) {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsReady(true), 30);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      style={{
        opacity: isReady ? 1 : 0,
        transform: isReady ? 'translateY(0)' : 'translateY(8px)',
        transition: `opacity ${duration}ms cubic-bezier(0.25,0.1,0.25,1), transform ${duration}ms cubic-bezier(0.25,0.1,0.25,1)`,
        willChange: 'opacity, transform',
      }}
    >
      {children}
    </div>
  );
}
