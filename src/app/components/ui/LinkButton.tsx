import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode, MouseEventHandler } from 'react';

export interface LinkButtonProps {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

const linkButtonVariantClass: Record<NonNullable<LinkButtonProps['variant']>, string> = {
  primary: 'bg-black text-white hover:bg-[#474747] border border-black',
  secondary: 'bg-white text-black hover:bg-black hover:text-white border border-black',
};

const linkButtonSizeClass: Record<NonNullable<LinkButtonProps['size']>, string> = {
  sm: 'px-3 py-2 text-xs',
  md: 'px-6 py-3 text-sm',
  lg: 'px-8 py-4 text-sm',
};

export function LinkButton({
  href,
  children,
  variant = 'secondary',
  size = 'md',
  className,
  onClick,
}: LinkButtonProps) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap tracking-widest transition-all duration-300 cursor-pointer',
        linkButtonVariantClass[variant],
        linkButtonSizeClass[size],
        className,
      )}
    >
      {children}
    </Link>
  );
}
