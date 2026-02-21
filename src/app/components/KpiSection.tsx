export default function KpiSection() {
	const monthlySales = [
		{ month: '1月', height: '65%' },
		{ month: '2月', height: '72%' },
		{ month: '3月', height: '58%' },
		{ month: '4月', height: '80%' },
		{ month: '5月', height: '95%' },
		{ month: '6月', height: '88%' },
		{ month: '7月', height: '102%' },
		{ month: '8月', height: '78%' },
		{ month: '9月', height: '85%' },
		{ month: '10月', height: '92%' },
		{ month: '11月', height: '110%' },
		{ month: '12月', height: '98%' },
	];

	const categorySales = [
		{ name: 'トップス', value: '¥1,250,000 (35%)', width: '35%' },
		{ name: 'ボトムス', value: '¥980,000 (28%)', width: '28%' },
		{ name: 'アウター', value: '¥750,000 (21%)', width: '21%' },
		{ name: 'アクセサリー', value: '¥570,000 (16%)', width: '16%' },
	];

	const topProducts = [
		{ rank: 1, name: 'オーバーサイズ リネンシャツ', sales: '¥585,000', units: '45点' },
		{ rank: 2, name: 'ワイドレッグ パンツ', sales: '¥494,000', units: '38点' },
		{ rank: 3, name: 'カシミア ニットカーディガン', sales: '¥768,000', units: '32点' },
		{ rank: 4, name: 'シルク ブラウス', sales: '¥392,000', units: '28点' },
		{ rank: 5, name: 'テーラード ジャケット', sales: '¥576,000', units: '24点' },
	];

	const stockAlerts = [
		{ name: 'オーバーサイズ リネンシャツ (M)', badge: '残り3点', badgeClass: 'bg-red-100 text-red-800' },
		{ name: 'ワイドレッグ パンツ (S)', badge: '残り5点', badgeClass: 'bg-yellow-100 text-yellow-800' },
		{ name: 'シルク ブラウス (L)', badge: '残り8点', badgeClass: 'bg-yellow-100 text-yellow-800' },
		{ name: 'カシミア ニット (M)', badge: '残り2点', badgeClass: 'bg-red-100 text-red-800' },
	];

	return (
		<section>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">本日の売上</p>
					<p className="text-3xl text-black mb-1 font-didot">¥248,000</p>
					<p className="text-xs text-green-600 font-acumin">+12.5% 前日比</p>
				</div>
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">本日の注文数</p>
					<p className="text-3xl text-black mb-1 font-didot">18</p>
					<p className="text-xs text-green-600 font-acumin">+3 前日比</p>
				</div>
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">コンバージョン率</p>
					<p className="text-3xl text-black mb-1 font-didot">3.2%</p>
					<p className="text-xs text-red-600 font-acumin">-0.3% 前日比</p>
				</div>
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">平均注文単価</p>
					<p className="text-3xl text-black mb-1 font-didot">¥13,778</p>
					<p className="text-xs text-green-600 font-acumin">+¥1,200 前日比</p>
				</div>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">月間売上推移</p>
					<div className="h-48 flex items-end justify-between gap-2">
						{monthlySales.map((item) => (
							<div key={item.month} className="flex-1 flex flex-col items-center">
								<div
									className="w-full bg-black/80 hover:bg-black transition-colors cursor-pointer"
									style={{ height: item.height }}
								/>
								<span className="text-xs text-[#474747] mt-2 font-acumin">{item.month}</span>
							</div>
						))}
					</div>
				</div>

				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">カテゴリ別売上</p>
					<div className="space-y-4">
						{categorySales.map((item) => (
							<div key={item.name}>
								<div className="flex justify-between mb-1">
									<span className="text-xs text-[#474747] font-acumin">{item.name}</span>
									<span className="text-xs text-black font-acumin">{item.value}</span>
								</div>
								<div className="h-2 bg-[#f5f5f5] rounded-full overflow-hidden">
									<div className="h-full bg-black" style={{ width: item.width }} />
								</div>
							</div>
						))}
					</div>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">本日のPV</p>
					<p className="text-3xl text-black mb-1 font-didot">2,456</p>
					<p className="text-xs text-green-600 font-acumin">+8.2% 前日比</p>
				</div>
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">カート追加率</p>
					<p className="text-3xl text-black mb-1 font-didot">8.5%</p>
					<p className="text-xs text-green-600 font-acumin">+0.5% 前日比</p>
				</div>
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-xs text-[#474747] tracking-widest mb-2 font-acumin">カート離脱率</p>
					<p className="text-3xl text-black mb-1 font-didot">62.3%</p>
					<p className="text-xs text-red-600 font-acumin">+2.1% 前日比</p>
				</div>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">売れ筋商品 TOP5</p>
					<div className="space-y-3">
						{topProducts.map((item) => (
							<div key={item.rank} className="flex items-center justify-between py-2 border-b border-[#f5f5f5] last:border-0">
								<div className="flex items-center gap-4">
									<span className="w-6 h-6 bg-black text-white text-xs flex items-center justify-center font-acumin">
										{item.rank}
									</span>
									<span className="text-sm text-black font-acumin">{item.name}</span>
								</div>
								<div className="text-right">
									<p className="text-sm text-black font-acumin">{item.sales}</p>
									<p className="text-xs text-[#474747] font-acumin">{item.units}</p>
								</div>
							</div>
						))}
					</div>
				</div>

				<div className="border border-[#d5d0c9] p-6">
					<p className="text-sm text-black tracking-widest mb-4 font-acumin">在庫アラート</p>
					<div className="space-y-3">
						{stockAlerts.map((item) => (
							<div key={item.name} className="flex items-center justify-between py-2 border-b border-[#f5f5f5] last:border-0">
								<span className="text-sm text-black font-acumin">{item.name}</span>
								<div className="flex items-center gap-3">
									<span className={`px-2 py-1 text-xs font-acumin ${item.badgeClass}`}>{item.badge}</span>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
