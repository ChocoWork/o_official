const CATEGORIES = ['TOPS', 'BOTTOMS', 'OUTERWEAR', 'ACCESSORIES'] as const;
const SIZES = ['S', 'M', 'L', 'FREE'] as const;

export default function AdminItemCreatePage() {
	return (
		<main className="pt-32 pb-20">
			<div className="max-w-4xl mx-auto px-6 lg:px-12">
				<form className="space-y-8">
					<div>
						<label className="block text-sm tracking-widest mb-2">商品画像URL</label>
						<div className="mb-4">
							<input
								className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black mb-2"
								placeholder="画像URL 1"
								type="text"
							/>
						</div>
						<div className="mb-4">
							<input
								className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black mb-2"
								placeholder="画像URL 2"
								type="text"
							/>
						</div>
						<button
							type="button"
							className="px-6 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
						>
							画像を追加
						</button>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">カテゴリー</label>
						<div className="relative">
							<select className="w-full px-4 py-3 pr-8 border border-black/20 text-sm focus:outline-none focus:border-black appearance-none cursor-pointer">
								{CATEGORIES.map((category) => (
									<option key={category} value={category}>
										{category}
									</option>
								))}
							</select>
							<i className="ri-arrow-down-s-line absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"></i>
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">商品名</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							required
							type="text"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">価格（円）</label>
						<input
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
							required
							type="number"
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">商品情報</label>
						<textarea
							rows={4}
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none"
							required
						/>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">カラー</label>
						<div className="flex gap-2 mb-2">
							<input
								className="flex-1 px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black"
								placeholder="カラー名"
								type="text"
							/>
						</div>
						<button
							type="button"
							className="px-6 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
						>
							カラーを追加
						</button>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">サイズ</label>
						<div className="flex gap-3 flex-wrap">
							{SIZES.map((size) => (
								<button
									key={size}
									type="button"
									className="px-6 py-2 text-xs tracking-widest transition-all duration-300 cursor-pointer whitespace-nowrap border border-black text-black hover:bg-black hover:text-white"
								>
									{size}
								</button>
							))}
						</div>
					</div>

					<div>
						<label className="block text-sm tracking-widest mb-2">PRODUCT DETAILS（素材・洗濯の情報）</label>
						<textarea
							rows={6}
							className="w-full px-4 py-3 border border-black/20 text-sm focus:outline-none focus:border-black resize-none"
							placeholder="素材： 洗濯： 生産国："
							required
						/>
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
