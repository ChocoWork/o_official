import Image from 'next/image';
import Link from 'next/link';
import { Item } from '@/app/types/item';

type PublicItemGridProps = {
  items: Item[];
  className?: string;
  /** lg未満の画面でこのインデックス以降のアイテムを非表示にする */
  mobileLimit?: number;
};

export function PublicItemGrid({ items, className, mobileLimit }: PublicItemGridProps) {
  const gridClassName = `${className ?? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8'} w-full`;

  return (
    <div className={gridClassName}>
      {items.map((item, index) => (
        <Link
          key={item.id}
          href={`/item/${item.id}`}
          className={mobileLimit !== undefined && index >= mobileLimit ? 'hidden lg:block' : undefined}
        >
          <div className="group cursor-pointer">
            <div className="aspect-[3/4] bg-[#f5f5f5] mb-4 overflow-hidden">
              {item.image_url ? (
                <Image
                  src={item.image_url}
                  alt={item.name}
                  width={600}
                  height={800}
                  className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                  priority={false}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  No Image
                </div>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-xs text-[#474747] tracking-widest font-brand">{item.category}</p>
              <h3 className="text-base text-black tracking-tight font-brand">{item.name}</h3>
              <p className="text-sm text-black font-brand">¥{item.price.toLocaleString('ja-JP')}</p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
