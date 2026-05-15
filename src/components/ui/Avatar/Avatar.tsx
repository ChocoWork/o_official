import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface AvatarProps {
  src?: string;
  alt: string;
  fallback: string;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  className?: string;
  status?: 'online' | 'offline';
}

const avatarSizeClass: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'h-8 w-8 text-sm',
  md: 'h-12 w-12 text-base',
  lg: 'h-16 w-16 text-xl',
};

export function Avatar({ src, alt, fallback, size = 'md', icon, className, status }: AvatarProps) {
  return (
    <div className="relative inline-flex">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className={cn('rounded-full object-cover', avatarSizeClass[size], className)} />
      ) : (
        <div className={cn('inline-flex items-center justify-center rounded-full bg-black text-white', avatarSizeClass[size], className)}>
          {icon ?? fallback}
        </div>
      )}
      {status === 'online' ? (
        <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-green-500"></span>
      ) : null}
    </div>
  );
}
