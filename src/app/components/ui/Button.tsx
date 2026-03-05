import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { ButtonHTMLAttributes, AnchorHTMLAttributes, MouseEventHandler } from 'react';

export type UIButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
export type UIButtonSize = 'sm' | 'md' | 'lg';

const buttonVariantClass: Record<UIButtonVariant, string> = {
  primary:
    'bg-black text-white hover:bg-[#474747] border border-black disabled:bg-black/20 disabled:text-white disabled:border-black/20 disabled:hover:bg-black/20',
  secondary:
    'bg-white text-black hover:bg-black hover:text-white border border-black disabled:bg-white disabled:text-black/40 disabled:border-black/20 disabled:hover:bg-white',
  danger:
    'bg-black text-white hover:bg-[#474747] border border-black disabled:bg-black/20 disabled:text-white disabled:border-black/20 disabled:hover:bg-black/20',
  ghost: 'bg-transparent text-black hover:bg-black/5 border border-transparent',
  link: 'bg-transparent text-black underline-offset-2 hover:underline border border-transparent px-0 py-0',
};

const buttonSizeClass: Record<UIButtonSize, string> = {
  sm: 'px-3 py-2 text-xs',
  md: 'px-6 py-3 text-sm',
  lg: 'px-8 py-4 text-sm',
};

// union of button and anchor attributes so `href` use works
export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  variant?: UIButtonVariant | 'text';
  size?: UIButtonSize;
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
}

export function Button({
  href,
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  disabled,
  children,
  ...props
}: ButtonProps) {
  const resolvedVariantClass =
    variant === 'text'
      ? 'bg-transparent text-black hover:text-[#474747] border border-transparent disabled:text-black/40 disabled:hover:text-black/40'
      : buttonVariantClass[variant as UIButtonVariant];

  const baseClass = cn(
    'inline-flex items-center justify-center whitespace-nowrap tracking-widest transition-all duration-300',
    resolvedVariantClass,
    buttonSizeClass[size as UIButtonSize],
    className,
    disabled && 'cursor-not-allowed',
  );

  if (href) {
    // render as link for navigation; disabled link still styled but not clickable
    return (
      <Link href={href} className={baseClass} {...(disabled ? { onClick: (e) => e.preventDefault() } : {})} {...props}>
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={baseClass}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}