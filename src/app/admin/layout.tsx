'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

const ADMIN_FONT_BODY_CLASS = 'admin-font-active';

/**
 * サイドナビを表示する管理ページ（FREQ-402）。
 *
 * 左の背景パネルはサイドナビの下地で、ナビが画面全高に見えるようにするためのもの（FREQ-204）。
 * ナビが無いページに置くと、幅 224px ぶんの内容を覆うだけになる。このパネルは
 * pointer-events: none なので当たり判定に出ず、横スクロールも起こさないため、
 * 「左端が静かに隠れる」形でしか表面化しない。出す場所を明示して限定する。
 */
const SIDENAV_PATHS = new Set(['/admin']);

export default function AdminLayout({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const showsSideNavBackground = SIDENAV_PATHS.has(pathname ?? '');

	useEffect(() => {
		document.body.classList.add(ADMIN_FONT_BODY_CLASS);

		return () => {
			document.body.classList.remove(ADMIN_FONT_BODY_CLASS);
		};
	}, []);

	return (
		<div className="admin-font-scope">
			{showsSideNavBackground && (
				<div
					aria-hidden="true"
					data-admin-sidenav-background
					className="pointer-events-none fixed inset-y-0 left-0 z-20 hidden w-56 bg-[#f4f4f4] lg:block"
				/>
			)}
			{children}
		</div>
	);
}
