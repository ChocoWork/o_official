"use client";

import React from 'react';
import Link from 'next/link';

interface EmptyCartProps {
  onStartShopping?: () => void;
}

export const EmptyCart: React.FC<EmptyCartProps> = ({ onStartShopping }) => {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-4xl mx-auto">
        <h1
          className="text-4xl lg:text-5xl text-black mb-16 tracking-tight text-center"
          style={{ fontFamily: 'Didot, serif' }}
        >
          SHOPPING CART
        </h1>

        <div className="text-center py-20">
          <div className="w-20 h-20 mx-auto flex items-center justify-center mb-6">
            <i className="ri-shopping-bag-line text-6xl text-[#474747]"></i>
          </div>

          <p className="text-lg text-[#474747] mb-8" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
            カートは空です
          </p>

          <Link
            href="/item"
            className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
            style={{ fontFamily: 'acumin-pro, sans-serif' }}
            onClick={() => onStartShopping && onStartShopping()}
          >
            CONTINUE SHOPPING
          </Link>
        </div>
      </div>
    </main>
  );
};