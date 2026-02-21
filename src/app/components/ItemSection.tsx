import Link from 'next/link';
import Image from 'next/image';

interface ItemCardProps {
  id: string;
  name: string;
  category: string;
  price: string;
  imageSrc: string;
  alt: string;
}

function ItemCard({ id, name, category, price, imageSrc, alt }: ItemCardProps) {
  return (
    <div className="border border-[#d5d0c9] overflow-hidden">
      <Image
        alt={alt}
        className="w-full aspect-[3/4] object-cover bg-[#f5f5f5]"
        src={imageSrc}
        width={300}
        height={400}
      />
      <div className="p-4 space-y-3">
        <div className="flex items-center space-x-2">
          <span className="px-3 py-1 text-xs tracking-widest bg-black text-white font-acumin">
            公開中
          </span>
          <span className="text-xs text-[#474747] tracking-widest font-acumin">
            {category}
          </span>
        </div>
        <h4 className="text-base text-black font-acumin">{name}</h4>
        <p className="text-sm text-black font-acumin">{price}</p>
        <div className="flex space-x-2 pt-2">
          <button className="flex-1 px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
            非公開
          </button>
          <Link className="flex-1" href={`/viewer/readdy-nextjs-v1-prod/807e1da6667908/admin/item/edit/${id}`}>
            <button className="w-full px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
              編集
            </button>
          </Link>
          <button className="px-4 py-2 bg-black text-white text-xs tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin">
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ItemSection() {
  const items = [
    {
      id: '4c7e91fe-8e40-492d-acaf-8a8e334c32ed',
      name: 'Leather Tote Bag',
      category: 'ACCESSORIES',
      price: '¥38,000',
      imageSrc: '/placeholder.png',
      alt: 'Leather Tote Bag',
    },
    {
      id: '69d085ad-4f19-4952-889b-589bd896af7c',
      name: 'Oversized Coat',
      category: 'OUTERWEAR',
      price: '¥58,000',
      imageSrc: '/placeholder.png',
      alt: 'Oversized Coat',
    },
    {
      id: 'ae215d14-4594-49a9-b4bf-c86f8db893a3',
      name: 'Linen Blend Shirt',
      category: 'TOPS',
      price: '¥24,800',
      imageSrc: '/placeholder.png',
      alt: 'Linen Blend Shirt',
    },
    {
      id: 'dc86be17-63ad-421f-a5b2-9a80f0ccfd28',
      name: 'Cotton Knit Sweater',
      category: 'TOPS',
      price: '¥22,000',
      imageSrc: '/placeholder.png',
      alt: 'Cotton Knit Sweater',
    },
    {
      id: '24db82e6-804a-4a9d-a73e-3efecd78cc0c',
      name: 'Wide Leg Trousers',
      category: 'BOTTOMS',
      price: '¥28,600',
      imageSrc: '/placeholder.png',
      alt: 'Wide Leg Trousers',
    },
    {
      id: 'c54ec7c1-d064-46ce-bf21-c31ecfe1720e',
      name: 'Silk Blend Dress',
      category: 'TOPS',
      price: '¥42,000',
      imageSrc: '/placeholder.png',
      alt: 'Silk Blend Dress',
    },
  ];

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {items.map((item) => (
          <ItemCard key={item.id} {...item} />
        ))}
      </div>
    </div>
  );
}