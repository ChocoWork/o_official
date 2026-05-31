"use client";

import React from 'react';
import { Button } from '@/components/ui/Button/Button';

type EmptyCartIconSizeToken = '4xl' | '5xl' | '6xl' | '7xl' | '8xl';

const iconSize4xlFallback = 'var(--lk-size-4xl, calc(var(--lk-size-3xl) * var(--lk-quarterstep)))';

const iconSizeByToken: Record<EmptyCartIconSizeToken, string> = {
  '4xl': iconSize4xlFallback,
  '5xl': `var(--lk-size-5xl, calc(${iconSize4xlFallback} * var(--lk-quarterstep)))`,
  '6xl': `var(--lk-size-6xl, calc(${iconSize4xlFallback} * var(--lk-quarterstep) * var(--lk-quarterstep)))`,
  '7xl': `var(--lk-size-7xl, calc(${iconSize4xlFallback} * var(--lk-quarterstep) * var(--lk-quarterstep) * var(--lk-quarterstep)))`,
  '8xl': `var(--lk-size-8xl, calc(${iconSize4xlFallback} * var(--lk-quarterstep) * var(--lk-quarterstep) * var(--lk-quarterstep) * var(--lk-quarterstep)))`,
};

interface EmptyCartProps {
  onStartShopping?: () => void;
  iconSizeToken?: EmptyCartIconSizeToken;
}

export const EmptyCart: React.FC<EmptyCartProps> = ({ onStartShopping, iconSizeToken = '4xl' }) => {
  const emptyStateSize = iconSizeByToken[iconSizeToken];
  const emptyIconFrameStyle: React.CSSProperties = {
    gap: `calc(${emptyStateSize} / 1.618)`,
    marginBottom: 'calc(var(--lk-size-md) * 1.4)',
  };
  const emptyIconStyle: React.CSSProperties = {
    fontSize: emptyStateSize,
    lineHeight: 1,
  };
  const emptyStateTextStyle: React.CSSProperties = {
    fontSize: emptyStateSize,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  };

  return (
    <div className="flex w-full flex-1 items-center justify-center">
      <div className="mx-auto w-full text-center">
        <div className="mx-auto flex items-center justify-center" style={emptyIconFrameStyle}>
          <i aria-hidden="true" className="ri-shopping-bag-line text-[#474747]" style={emptyIconStyle}></i>
          <span className="text-[#474747]" style={emptyStateTextStyle}>
            YOUR CART IS EMPTY
          </span>
        </div>

        <Button href="/item" size="xs" onClick={() => onStartShopping?.()}>
          CONTINUE SHOPPING
        </Button>
      </div>
    </div>
  );
};