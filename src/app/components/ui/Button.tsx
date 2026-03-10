import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

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
  sm: 'h-8 text-xs px-3',
  md: 'h-10 text-sm px-4',
  lg: 'h-12 text-sm px-5',
};

type ButtonBaseProps = {
  variant?: UIButtonVariant | 'text';
  size?: UIButtonSize;
  className?: string;
  children?: ReactNode;
};

type ButtonElementProps = ButtonBaseProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    href?: undefined;
  };

type AnchorElementProps = ButtonBaseProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'type' | 'disabled'> & {
    href: string;
    disabled?: boolean;
  };

export type ButtonProps = ButtonElementProps | AnchorElementProps;

export function Button(props: ButtonProps) {
  const { variant = 'primary', size = 'md', className } = props;
  const resolvedVariantClass =
    variant === 'text'
      ? 'bg-transparent text-black hover:text-[#474747] border border-transparent disabled:text-black/40 disabled:hover:text-black/40'
      : buttonVariantClass[variant as UIButtonVariant];

  const baseClass = cn(
    'inline-flex items-center justify-center whitespace-nowrap tracking-widest transition-all duration-300',
    resolvedVariantClass,
    buttonSizeClass[size as UIButtonSize],
    className,
  );

  if ('href' in props && props.href) {
    const { href, disabled, children, onClick, ...anchorProps } = props;

    const handleClick = (event: Parameters<NonNullable<AnchorElementProps['onClick']>>[0]) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    };

    // render as link for navigation; disabled link still styled but not clickable
    return (
      <Link
        href={href}
        className={cn(baseClass, disabled && 'cursor-not-allowed')}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : anchorProps.tabIndex}
        onClick={handleClick}
        {...anchorProps}
      >
        {children}
      </Link>
    );
  }

  const { type = 'button', disabled, children, ...buttonProps } = props as ButtonElementProps;

  return (
    <button
      type={type}
      className={cn(baseClass, disabled && 'cursor-not-allowed')}
      disabled={disabled}
      {...buttonProps}
    >
      {children}
    </button>
  );
}