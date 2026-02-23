import React from 'react';
import Link from 'next/link';
import WishlistClient from './client';

export default function Page() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-12">
          <h1 className="text-4xl text-black tracking-tight font-display">Wishlist</h1>
        </div>
        <WishlistClient />
      </div>
    </main>
  );
}
