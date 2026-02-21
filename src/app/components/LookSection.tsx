import Image from 'next/image';
import Link from 'next/link';

type LookItem = {
	id: string;
	title: string;
	isPublished: boolean;
	imageSrc: string;
};

export default function LookSection() {
	const lookItems: LookItem[] = [
		{
			id: '1',
			title: '2025 Spring/Summer',
			isPublished: true,
			imageSrc:
				'https://readdy.ai/api/search-image?query=high%20fashion%20model%20wearing%20elegant%20spring%20summer%20outfit%20minimalist%20studio%20photography%20white%20background%20editorial%20style&width=400&height=600&seq=look1&orientation=portrait',
		},
		{
			id: '2',
			title: '2025 Spring/Summer',
			isPublished: true,
			imageSrc:
				'https://readdy.ai/api/search-image?query=fashion%20editorial%20model%20in%20contemporary%20designer%20clothing%20clean%20aesthetic%20professional%20studio%20shot%20neutral%20tones&width=400&height=600&seq=look2&orientation=portrait',
		},
		{
			id: '3',
			title: '2024 Autumn/Winter',
			isPublished: true,
			imageSrc:
				'https://readdy.ai/api/search-image?query=elegant%20autumn%20winter%20fashion%20lookbook%20model%20wearing%20coat%20sophisticated%20style%20studio%20photography&width=400&height=600&seq=look3&orientation=portrait',
		},
		{
			id: '4',
			title: '2024 Autumn/Winter',
			isPublished: false,
			imageSrc:
				'https://readdy.ai/api/search-image?query=winter%20fashion%20collection%20model%20in%20layered%20outfit%20minimalist%20editorial%20photography%20muted%20colors&width=400&height=600&seq=look4&orientation=portrait',
		},
	];

	return (
		<section>
			<div className="flex justify-between items-center mb-8">
				<h3 className="text-2xl text-black font-didot">LOOK管理</h3>
				<Link
					href="/admin/look/create"
					className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
				>
					新規作成
				</Link>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
				{lookItems.map((item) => (
					<div key={item.id} className="border border-[#d5d0c9] overflow-hidden">
						<Image
							src={item.imageSrc}
							alt={item.title}
							width={400}
							height={600}
							className="w-full aspect-[2/3] object-cover bg-[#f5f5f5]"
						/>
						<div className="p-4 space-y-3">
							<div className="flex items-center space-x-2">
								<span
									className={`px-3 py-1 text-xs tracking-widest font-acumin ${
										item.isPublished ? 'bg-black text-white' : 'border border-black text-black'
									}`}
								>
									{item.isPublished ? '公開中' : '非公開'}
								</span>
							</div>
							<p className="text-sm text-black font-acumin">{item.title}</p>
							<div className="flex space-x-2 pt-2">
								<button className="flex-1 px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
									{item.isPublished ? '非公開' : '公開'}
								</button>
								<Link href={`/admin/look/edit/${item.id}`} className="flex-1">
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
				))}
			</div>
		</section>
	);
}
