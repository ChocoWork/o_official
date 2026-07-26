import { render } from '@testing-library/react';
import AdminLayout from '@/app/admin/layout';

describe('AdminLayout font scope', () => {
	it('admin表示中だけAcumin用のbodyクラスを適用する', () => {
		const { container, unmount } = render(
			<AdminLayout>
				<h1>管理画面</h1>
			</AdminLayout>,
		);

		expect(container.querySelector('.admin-font-scope')).toBeInTheDocument();
		expect(document.body).toHaveClass('admin-font-active');

		unmount();
		expect(document.body).not.toHaveClass('admin-font-active');
	});
});
