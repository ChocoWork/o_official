'use client';

import React from 'react';
import { CartProvider } from '@/contexts/CartContext';
import { LoginProvider } from '@/contexts/LoginContext';
import Header from './Header';
import Footer from './Footer';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CartProvider>
      <LoginProvider>
        <Header />
        <div className="flex-1 flex flex-col">
          {children}
        </div>
        <Footer />
      </LoginProvider>
    </CartProvider>
  );
}
