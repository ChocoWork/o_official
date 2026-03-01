import { cn } from '@/lib/utils';
import type { ButtonHTMLAttributes } from 'react';

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

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: UIButtonVariant | 'text';
  size?: UIButtonSize;
}

export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...props }: ButtonProps) {
  const resolvedVariantClass =
    variant === 'text'
      ? 'bg-transparent text-black hover:text-[#474747] border border-transparent disabled:text-black/40 disabled:hover:text-black/40'
      : buttonVariantClass[variant];

  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap tracking-widest transition-all duration-300 cursor-pointer disabled:cursor-not-allowed',
        resolvedVariantClass,
        buttonSizeClass[size],
        className,
      )}
      {...props}
    />
  );
}
