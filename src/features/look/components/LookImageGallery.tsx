'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';

type LookImageGalleryProps = {
  theme: string;
  imageUrls: string[];
};

export function LookImageGallery({ theme, imageUrls }: LookImageGalleryProps) {
  const normalizedImages = useMemo(() => {
    if (imageUrls.length === 0) {
      return ['/placeholder.png'];
    }

    return imageUrls;
  }, [imageUrls]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedImage = normalizedImages[selectedIndex] ?? normalizedImages[0];

  return (
    <div className="space-y-4">
      <div className="w-full aspect-[3/4] relative">
        <Image
          data-testid="look-main-image"
          key={`${theme}:${selectedImage}`}
          src={selectedImage}
          alt={`${theme} - ${selectedIndex + 1}枚目`}
          fill
          className="w-full h-full object-cover object-top"
          sizes="(min-width: 1024px) 50vw, 100vw"
          priority
          unoptimized
        />
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {normalizedImages.map((imageUrl, index) => (
          <button
            key={`${theme}:thumb:${index}:${imageUrl}`}
            data-testid="look-thumb-button"
            type="button"
            aria-label={`${theme} の ${index + 1}枚目を表示`}
            aria-pressed={selectedIndex === index}
            onClick={() => setSelectedIndex(index)}
            className={`relative w-16 h-20 shrink-0 border ${
              selectedIndex === index ? 'border-black' : 'border-black/20'
            }`}
          >
            <Image
              src={imageUrl}
              alt={`${theme} サムネイル ${index + 1}`}
              fill
              className="object-cover object-top"
              unoptimized
            />
          </button>
        ))}
      </div>
    </div>
  );
}
