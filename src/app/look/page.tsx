import React from "react";
import Link from "next/link";

// Temporary sample data - will be replaced with Supabase in the future
const SAMPLE_LOOKS = [
    {
        id: '1',
        lookNumber: '01',
        theme: 'Urban Minimalism',
        season: '2024 SPRING/SUMMER',
        mainImage: 'https://readdy.ai/api/search-image?query=Minimalist%20fashion%20editorial%20photography%20featuring%20elegant%20model%20wearing%20neutral%20beige%20and%20black%20layered%20outfit%20with%20clean%20lines%20in%20bright%20natural%20lighting%20against%20simple%20white%20architectural%20background%20showcasing%20timeless%20sophisticated%20style&width=800&height=1200&seq=look001&orientation=portrait',
    },
    {
        id: '2',
        lookNumber: '02',
        theme: 'Tailored Elegance',
        season: '2024 SPRING/SUMMER',
        mainImage: 'https://readdy.ai/api/search-image?query=Professional%20fashion%20lookbook%20image%20showing%20model%20in%20minimalist%20black%20tailored%20blazer%20and%20wide%20leg%20trousers%20with%20neutral%20background%20emphasizing%20clean%20silhouette%20and%20modern%20elegance%20in%20natural%20daylight&width=800&height=1200&seq=look002&orientation=portrait',
    },
    {
        id: '3',
        lookNumber: '03',
        theme: 'Dusk Reverie',
        season: '2024 SPRING/SUMMER',
        mainImage: 'https://readdy.ai/api/search-image?query=Elegant%20minimalist%20fashion%20photography%20with%20model%20wearing%20flowing%20silk%20shirt%20in%20sand%20beige%20color%20paired%20with%20soft%20cardigan%20against%20clean%20white%20background%20with%20soft%20shadows%20highlighting%20fabric%20texture%20and%20refined%20aesthetic&width=800&height=1200&seq=look003&orientation=portrait',
    },
    {
        id: '4',
        lookNumber: '04',
        theme: 'Structured Beauty',
        season: '2024 AUTUMN/WINTER',
        mainImage: 'https://readdy.ai/api/search-image?query=Sophisticated%20autumn%20fashion%20editorial%20showing%20model%20in%20elegant%20black%20wool%20coat%20over%20neutral%20dress%20with%20minimalist%20styling%20in%20soft%20natural%20light%20against%20simple%20architectural%20setting%20emphasizing%20timeless%20design&width=800&height=1200&seq=look004&orientation=portrait',
    },
    {
        id: '5',
        lookNumber: '05',
        theme: 'Texture Play',
        season: '2024 AUTUMN/WINTER',
        mainImage: 'https://readdy.ai/api/search-image?query=Modern%20minimalist%20lookbook%20photography%20featuring%20model%20in%20luxurious%20cashmere%20sweater%20and%20tailored%20linen%20pants%20in%20neutral%20tones%20with%20clean%20composition%20and%20soft%20lighting%20highlighting%20quality%20fabrics%20and%20sophisticated%20styling&width=800&height=1200&seq=look005&orientation=portrait',
    },
    {
        id: '6',
        lookNumber: '06',
        theme: 'Modern Sophistication',
        season: '2024 AUTUMN/WINTER',
        mainImage: 'https://readdy.ai/api/search-image?query=Refined%20fashion%20editorial%20image%20with%20model%20wearing%20structured%20black%20blazer%20over%20silk%20shirt%20in%20minimalist%20setting%20with%20natural%20lighting%20emphasizing%20sharp%20tailoring%20and%20elegant%20proportions%20in%20contemporary%20style&width=800&height=1200&seq=look006&orientation=portrait',
    },
];

export default function LookPage() {
    return (
        <main className="pt-32 pb-20 px-6 lg:px-12">
            <div className="max-w-7xl mx-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12">
                    {SAMPLE_LOOKS.map((look) => (
                        <Link key={look.id} href={`/look/${look.id}`} className="group">
                            <div className="aspect-[2/3] bg-[#f5f5f5] mb-6 overflow-hidden">
                                <img
                                    src={look.mainImage}
                                    alt={look.theme}
                                    className="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-500"
                                />
                            </div>
                            <div className="space-y-3">
                                <p className="text-xs text-[#474747] tracking-widest font-brand">{look.season}</p>
                                <p className="text-sm text-black font-brand">{look.theme}</p>
                            </div>
                        </Link>
                    ))}
                </div>
            </div>
        </main>
    );
}
