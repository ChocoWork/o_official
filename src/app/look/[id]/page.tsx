'use client';

import React, { useState } from 'react';
import Link from 'next/link';

// サンプルLookデータ
const SAMPLE_LOOKS = [
    {
        id: '1',
        lookNumber: '01',
        theme: 'Urban Minimalism',
        season: '2024 SPRING/SUMMER',
        description: 'Clean lines and neutral tones define this effortless spring look. The layering of textures creates depth while maintaining a cohesive color palette.',
        mainImage: 'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
        thumbnails: [
            'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
        ],
        items: [
            { id: 1, name: 'Minimal Wool Coat', price: '¥28,000', color: 'Charcoal' },
            { id: 5, name: 'Cashmere Blend Sweater', price: '¥18,000', color: 'Ivory' },
        ],
    },
    {
        id: '2',
        lookNumber: '02',
        theme: 'Tailored Elegance',
        season: '2024 SPRING/SUMMER',
        description: 'Professional yet refined, this look showcases the power of impeccable tailoring. The structured silhouette is balanced with softer fabrics for modern sophistication.',
        mainImage: 'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
        thumbnails: [
            'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
        ],
        items: [
            { id: 2, name: 'Tailored Blazer', price: '¥32,000', color: 'Black' },
            { id: 3, name: 'Wide Leg Trousers', price: '¥24,000', color: 'Black' },
        ],
    },
    {
        id: '3',
        lookNumber: '03',
        theme: 'Dusk Reverie',
        season: '2024 SPRING/SUMMER',
        description: 'Soft textures and warm neutrals create an ethereal aesthetic. This look celebrates the beauty of natural fabrics and understated luxury.',
        mainImage: 'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
        thumbnails: [
            'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
        ],
        items: [
            { id: 4, name: 'Silk Blend Shirt', price: '¥16,000', color: 'Sand' },
            { id: 6, name: 'Merino Wool Cardigan', price: '¥22,000', color: 'Oatmeal' },
        ],
    },
    {
        id: '4',
        lookNumber: '04',
        theme: 'Structured Beauty',
        season: '2024 AUTUMN/WINTER',
        description: 'Winter elegance meets modern minimalism. Rich textures and tonal layering create a sophisticated foundation for the colder seasons.',
        mainImage: 'https://readdy.ai/api/search-image?query=Sophisticated%20autumn%20fashion%20editorial%20showing%20model%20in%20elegant%20black%20wool%20coat%20over%20neutral%20dress%20with%20minimalist%20styling%20in%20soft%20natural%20light%20against%20simple%20architectural%20setting%20emphasizing%20timeless%20design&width=800&height=1200&seq=look004&orientation=portrait',
        thumbnails: [
            'https://readdy.ai/api/search-image?query=Sophisticated%20autumn%20fashion%20editorial%20showing%20model%20in%20elegant%20black%20wool%20coat%20over%20neutral%20dress%20with%20minimalist%20styling%20in%20soft%20natural%20light%20against%20simple%20architectural%20setting%20emphasizing%20timeless%20design&width=800&height=1200&seq=look004&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
        ],
        items: [
            { id: 7, name: 'Cotton Poplin Dress', price: '¥26,000', color: 'Taupe' },
            { id: 1, name: 'Minimal Wool Coat', price: '¥28,000', color: 'Charcoal' },
        ],
    },
    {
        id: '5',
        lookNumber: '05',
        theme: 'Texture Play',
        season: '2024 AUTUMN/WINTER',
        description: 'Mixing materials creates visual interest in this autumn edit. Cashmere meets linen in a harmonious blend of comfort and style.',
        mainImage: 'https://readdy.ai/api/search-image?query=Modern%20minimalist%20lookbook%20photography%20featuring%20model%20in%20luxurious%20cashmere%20sweater%20and%20tailored%20linen%20pants%20in%20neutral%20tones%20with%20clean%20composition%20and%20soft%20lighting%20highlighting%20quality%20fabrics%20and%20sophisticated%20styling&width=800&height=1200&seq=look005&orientation=portrait',
        thumbnails: [
            'https://readdy.ai/api/search-image?query=Modern%20minimalist%20lookbook%20photography%20featuring%20model%20in%20luxurious%20cashmere%20sweater%20and%20tailored%20linen%20pants%20in%20neutral%20tones%20with%20clean%20composition%20and%20soft%20lighting%20highlighting%20quality%20fabrics%20and%20sophisticated%20styling&width=800&height=1200&seq=look005&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
        ],
        items: [
            { id: 8, name: 'Linen Blend Pants', price: '¥20,000', color: 'Natural' },
            { id: 5, name: 'Cashmere Blend Sweater', price: '¥18,000', color: 'Ivory' },
        ],
    },
    {
        id: '6',
        lookNumber: '06',
        theme: 'Modern Sophistication',
        season: '2024 AUTUMN/WINTER',
        description: 'A study in contrast and balance, this look pairs sharp tailoring with fluid fabrics. The result is a timeless ensemble that transcends seasons.',
        mainImage: 'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
        thumbnails: [
            'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
            'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
        ],
        items: [
            { id: 2, name: 'Tailored Blazer', price: '¥32,000', color: 'Black' },
            { id: 4, name: 'Silk Blend Shirt', price: '¥16,000', color: 'Cream' },
        ],
    },
];

export default function LookDetailPage({ params }: { params: { id: string } }) {
    const look = SAMPLE_LOOKS.find((l) => l.id === params.id);
    const [selectedImageIndex, setSelectedImageIndex] = useState(0);

    if (!look) {
        return (
            <main className="pt-32 pb-20 px-6 lg:px-12">
                <div className="max-w-7xl mx-auto text-center">
                    <h1 className="text-2xl font-brand text-black">Look not found</h1>
                    <Link href="/look" className="text-sm text-[#474747] hover:text-black mt-4 inline-block">
                        Back to Lookbook
                    </Link>
                </div>
            </main>
        );
    }

    const currentLook = look;
    const currentIndex = SAMPLE_LOOKS.findIndex((l) => l.id === params.id);
    const prevLook = currentIndex > 0 ? SAMPLE_LOOKS[currentIndex - 1] : null;
    const nextLook = currentIndex < SAMPLE_LOOKS.length - 1 ? SAMPLE_LOOKS[currentIndex + 1] : null;

    const mainImage = currentLook.thumbnails[selectedImageIndex] || currentLook.mainImage;

    return (
        <main className="pt-32 pb-20 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                {/* Back to Lookbook */}
                <Link
                    href="/look"
                    className="flex items-center space-x-2 text-sm text-[#474747] mb-12 hover:text-black transition-colors duration-300"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                >
                    <i className="ri-arrow-left-line w-4 h-4 flex items-center justify-center"></i>
                    <span className="tracking-widest">BACK TO LOOKBOOK</span>
                </Link>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
                    {/* Left: Image Gallery */}
                    <div className="space-y-4">
                        {/* Main Image */}
                        <div className="w-full aspect-[3/4] bg-[#f5f5f5] overflow-hidden">
                            <img
                                src={mainImage}
                                alt={`${currentLook.theme}`}
                                className="w-full h-full object-cover object-top"
                            />
                        </div>

                        {/* Thumbnails */}
                        <div className="grid grid-cols-4 gap-3">
                            {currentLook.thumbnails.map((thumbnail, index) => (
                                <button
                                    key={index}
                                    onClick={() => setSelectedImageIndex(index)}
                                    className={`aspect-[3/4] bg-[#f5f5f5] overflow-hidden cursor-pointer transition-opacity duration-300 ${
                                        selectedImageIndex === index
                                            ? 'ring-2 ring-black'
                                            : 'opacity-60 hover:opacity-100'
                                    }`}
                                >
                                    <img
                                        src={thumbnail}
                                        alt={`${currentLook.theme} detail ${index + 1}`}
                                        className="w-full h-full object-cover object-top"
                                    />
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Right: Details */}
                    <div className="lg:pt-8 space-y-10">
                        {/* Header: Season, Look Number, Theme */}
                        <div>
                            <p className="text-xs text-[#474747] tracking-widest mb-4" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                {currentLook.season}
                            </p>
                            <h1 className="text-4xl lg:text-5xl text-black mb-3" style={{ fontFamily: 'Didot, serif' }}>
                                LOOK {currentLook.lookNumber}
                            </h1>
                            <p className="text-lg text-[#474747] tracking-wide" style={{ fontFamily: 'Didot, serif' }}>
                                {currentLook.theme}
                            </p>
                        </div>

                        {/* Description */}
                        <div className="border-t border-[#d5d0c9] pt-8">
                            <p className="text-sm text-[#474747] leading-[2]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                {currentLook.description}
                            </p>
                        </div>

                        {/* Styling Items */}
                        <div className="border-t border-[#d5d0c9] pt-8">
                            <h3 className="text-xs text-black tracking-widest mb-6" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                STYLING ITEMS
                            </h3>
                            <div className="space-y-4">
                                {currentLook.items.map((item) => (
                                    <div
                                        key={item.id}
                                        className="flex items-center justify-between py-3 border-b border-[#f0ede8]"
                                    >
                                        <span className="text-sm text-black tracking-wide" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            {item.name}
                                        </span>
                                        <span className="text-sm text-[#474747]" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            {item.price}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Navigation */}
                        <div className="flex items-center justify-between pt-4">
                            {prevLook ? (
                                <Link
                                    href={`/look/${prevLook.id}`}
                                    className="group flex items-center space-x-3 cursor-pointer"
                                >
                                    <i className="ri-arrow-left-line w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors"></i>
                                    <div>
                                        <p className="text-xs text-[#999] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            PREV
                                        </p>
                                        <p className="text-sm text-[#474747] group-hover:text-black transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            LOOK {prevLook.lookNumber}
                                        </p>
                                    </div>
                                </Link>
                            ) : (
                                <div />
                            )}
                            {nextLook ? (
                                <Link
                                    href={`/look/${nextLook.id}`}
                                    className="group flex items-center space-x-3 cursor-pointer text-right"
                                >
                                    <div>
                                        <p className="text-xs text-[#999] tracking-widest" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            NEXT
                                        </p>
                                        <p className="text-sm text-[#474747] group-hover:text-black transition-colors" style={{ fontFamily: 'acumin-pro, sans-serif' }}>
                                            LOOK {nextLook.lookNumber}
                                        </p>
                                    </div>
                                    <i className="ri-arrow-right-line w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors"></i>
                                </Link>
                            ) : (
                                <div />
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
