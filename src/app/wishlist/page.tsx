import React from 'react';
import WishlistClient from './client';

export default function Page() {
  return (
    <div className="element-width">
      <div className="flex items-center justify-between mb-12">
        <h1 style={{ fontSize: 'var(--lk-size-4xl)' }}>Wishlist</h1>
      </div>
      <WishlistClient />
    </div>
  );
}
