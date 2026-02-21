import Image from 'next/image';

const SAMPLE_ITEMS = [
	{ name: 'Leather Tote Bag', price: '¥38,000' },
	{ name: 'Oversized Coat', price: '¥58,000' },
	{ name: 'Linen Blend Shirt', price: '¥24,800' },
	{ name: 'Cotton Knit Sweater', price: '¥22,000' },
	{ name: 'Wide Leg Trousers', price: '¥28,600' },
	{ name: 'Silk Blend Dress', price: '¥42,000' },
] as const;

export default function AdminLookCreatePage() {
	return (
		<main className="pt-32 pb-20">
			<div className="max-w-4xl mx-auto px-6 lg:px-12">
				<h1 className="text-4xl text-black mb-12 tracking-tight font-serif">LOOK作成</h1>

				<form className="space-y-8">
					<div>
						<label className="block text-sm tracking-widest mb-2">タイトル</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							placeholder="例: 2024 SPRING/SUMMER"
							required
							type="text"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">シーズン説明</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							placeholder="例: Effortless Elegance"
							required
							type="text"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">画像URL</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							placeholder="https://..."
							required
							type="text"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-4">紐づける商品を選択</label>
						<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
							{SAMPLE_ITEMS.map((item) => (
								<div
									key={item.name}
									className="border cursor-pointer transition-all duration-300 border-black/20 hover:border-black"
								>
									<div className="aspect-[3/4] bg-[#f5f5f5] overflow-hidden relative">
										<Image
											src="/images/items/search-image.png"
											alt={item.name}
											fill
											sizes="(max-width: 768px) 50vw, 33vw"
											className="object-cover object-top"
										/>
									</div>
									<div className="p-3">
										<p className="text-xs text-black mb-1">{item.name}</p>
										<p className="text-xs text-[#474747]">{item.price}</p>
									</div>
								</div>
							))}
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">ステータス</label>
						<div className="flex gap-4">
							<label className="flex items-center gap-2 cursor-pointer">
								<input className="cursor-pointer" type="radio" name="status" value="draft" defaultChecked />
								<span className="text-sm">下書き</span>
							</label>
							<label className="flex items-center gap-2 cursor-pointer">
								<input className="cursor-pointer" type="radio" name="status" value="published" />
								<span className="text-sm">公開</span>
							</label>
						</div>
					</div>

					<div className="flex gap-4">
						<button
							type="button"
							className="px-8 py-3 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
						>
							キャンセル
						</button>
						<button
							type="submit"
							className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap disabled:opacity-50"
						>
							保存
						</button>
					</div>
				</form>
			</div>
		</main>
	);
}
