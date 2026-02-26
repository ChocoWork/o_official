import { cn } from '@/lib/utils';

export interface AvatarProps {
  src?: string;
  alt: string;
  fallback: string;
  size?: 'sm' | 'md' | 'lg';
}

const avatarSizeClass: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-lg',
};

export function Avatar({ src, alt, fallback, size = 'md' }: AvatarProps) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={cn('rounded-full object-cover', avatarSizeClass[size])} />
  ) : (
    <div className={cn('inline-flex items-center justify-center rounded-full bg-black text-white', avatarSizeClass[size])}>{fallback}</div>
  );
}
