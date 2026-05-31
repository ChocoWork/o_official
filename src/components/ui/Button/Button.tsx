import "./Button.css";
import type { ButtonProps } from './Button';
import Link from 'next/link';
import type {
  AnchorHTMLAttributes,
} from 'react';

export function Button({
  href,
  variant = 'primary',
  size = 'md',
  shape = 'square',
  className,
  type = 'button',
  disabled,
  children,
  ...props
}: ButtonProps) {
  const dataAttrs = {
    'data-ui-button': 'true',
    'data-ui-button-variant': variant,
    'data-ui-button-size': size,
    'data-ui-button-shape': shape,
    'data-ui-button-disabled': disabled ? 'true' : undefined,
  } as const;

  if (href) {
    const anchorProps = props as AnchorHTMLAttributes<HTMLAnchorElement>;
    const { onClick: anchorOnClick, tabIndex: anchorTabIndex, ...restAnchorProps } = anchorProps;

    return (
      <Link
        href={href}
        {...restAnchorProps}
        {...dataAttrs}
        className={className}
        aria-disabled={disabled ? true : undefined}
        tabIndex={disabled ? -1 : anchorTabIndex}
        onClick={disabled ? (event) => event.preventDefault() : anchorOnClick}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      {...dataAttrs}
      className={className}
    >
      {children}
    </button>
  );
}