import React from 'react';

export default function Page() {
	return (
		<main className="pt-32 pb-20 px-6 lg:px-12">
			<div className="max-w-3xl mx-auto text-center">
				<div className="w-20 h-20 flex items-center justify-center mx-auto mb-8">
					<i className="ri-user-line text-6xl text-[#474747]"></i>
				</div>
				<h1 className="text-4xl text-black tracking-tight mb-4 font-display">
					会員情報
				</h1>
				<p className="text-lg text-[#474747] mb-8 font-brand">
					会員情報を確認するにはログインが必要です
				</p>
				<a
					className="inline-block px-12 py-4 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap font-brand"
					href="/login"
				>
					ログイン
				</a>
			</div>
		</main>
	);
}
