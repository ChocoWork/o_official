'use client';

import { useEffect, type ReactNode } from 'react';

const ADMIN_FONT_BODY_CLASS = 'admin-font-active';

export default function AdminLayout({ children }: { children: ReactNode }) {
	useEffect(() => {
		document.body.classList.add(ADMIN_FONT_BODY_CLASS);

		return () => {
			document.body.classList.remove(ADMIN_FONT_BODY_CLASS);
		};
	}, []);

	return <div className="admin-font-scope">{children}</div>;
}
