import type { ReactNode } from 'react';
import type { ComponentSize } from './types';

export interface TagLabelProps {
  children: ReactNode;
  variant?: 'solid' | 'outline' | 'subtle';
  rounded?: boolean;
  removable?: boolean;
  onRemove?: () => void;
  className?: string;
  /** tag size */
  size?: ComponentSize;
}

export function TagLabel({
  children,
  variant = 'outline',
  rounded = false,
  removable = false,
  onRemove,
  className,
  size = 'md',
}: TagLabelProps) {
  const isRemovable = removable && typeof onRemove === 'function';

  return (
    <span
      data-ui-tag-label="true"
      data-ui-tag-label-variant={variant}
      data-ui-tag-label-size={size}
      data-ui-tag-label-rounded={rounded ? 'true' : undefined}
      data-ui-tag-label-removable={isRemovable ? 'true' : undefined}
      className={className}
    >
      {children}
      {isRemovable ? (
        <button
          type="button"
          data-ui-tag-label-remove="true"
          aria-label="Remove tag"
          onClick={onRemove}
        >
          <i aria-hidden="true" className="ri-close-line" data-ui-tag-label-remove-icon="true"></i>
        </button>
      ) : null}
    </span>
  );
}
