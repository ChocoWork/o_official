"use client";

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';

type AdminLookItem = {
	id: number;
	season_year: number;
	season_type: 'SS' | 'AW';
	theme: string;
	image_urls: string[];
	status: 'private' | 'published';
};

export default function LookSection() {
	const [lookItems, setLookItems] = useState<AdminLookItem[]>([]);
	const [loading, setLoading] = useState(true);

	const fetchLooks = async () => {
		try {
			const res = await clientFetch('/api/admin/looks');
			if (!res.ok) {
				throw new Error('Failed to fetch looks');
			}

			const json = await res.json();
			setLookItems((json.data || []) as AdminLookItem[]);
		} catch (error) {
			console.error('Failed to load looks:', error);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void fetchLooks();
	}, []);

	const handleToggleStatus = async (id: number, currentStatus: 'private' | 'published') => {
		const nextStatus = currentStatus === 'published' ? 'private' : 'published';

		try {
			const res = await clientFetch(`/api/admin/looks/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: nextStatus }),
			});

			if (!res.ok) {
				throw new Error('Failed to update status');
			}

			await fetchLooks();
		} catch (error) {
			console.error('Failed to toggle look status:', error);
			alert('ステータスの更新に失敗しました');
		}
	};

	const handleDelete = async (id: number) => {
		if (!confirm('このLOOKを削除してもよろしいですか？')) {
			return;
		}

		try {
			const res = await clientFetch(`/api/admin/looks/${id}`, {
				method: 'DELETE',
			});

			if (!res.ok) {
				throw new Error('Failed to delete look');
			}

			await fetchLooks();
		} catch (error) {
			console.error('Failed to delete look:', error);
			alert('LOOKの削除に失敗しました');
		}
	};

	if (loading) {
		return <div className="text-center py-12 font-acumin">読み込み中...</div>;
	}

	if (lookItems.length === 0) {
		return <div className="text-center py-12 text-[#474747] font-acumin">LOOKがありません</div>;
	}

	return (
		<section>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
				{lookItems.map((item) => (
					<div key={item.id} className="border border-[#d5d0c9] overflow-hidden">
						<Image
							src={item.image_urls?.[0] || '/placeholder.png'}
							alt={item.theme}
							width={400}
							height={600}
							className="w-full aspect-[2/3] object-cover bg-[#f5f5f5]"
							unoptimized
						/>
						<div className="p-4 space-y-3">
							<div className="flex items-center space-x-2">
								<span
									className={`px-3 py-1 text-xs tracking-widest font-acumin ${
										item.status === 'published' ? 'bg-black text-white' : 'border border-black text-black'
									}`}
								>
									{item.status === 'published' ? '公開中' : '非公開'}
								</span>
							</div>
							<p className="text-xs text-[#474747] tracking-widest font-acumin">
								{item.season_year} {item.season_type}
							</p>
							<p className="text-sm text-black font-acumin">{item.theme}</p>
							<div className="flex space-x-2 pt-2">
								<button
									onClick={() => handleToggleStatus(item.id, item.status)}
									className="flex-1 px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin"
								>
									{item.status === 'published' ? '非公開' : '公開'}
								</button>
								<Link href={`/admin/look/edit/${item.id}`} className="flex-1">
									<button className="w-full px-4 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
										編集
									</button>
								</Link>
								<button
									onClick={() => handleDelete(item.id)}
									className="px-4 py-2 bg-black text-white text-xs tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
								>
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
