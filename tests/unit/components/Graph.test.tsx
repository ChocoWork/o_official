import { render, screen } from '@testing-library/react';
import { Graph } from '@/components/ui/Graph/Graph';

describe('Graph line series gaps', () => {
	it('nullの月を点として描かず前後の値を接続しない', () => {
		render(
			<Graph
				variant="line"
				categories={['4月', '5月', '6月']}
				series={[{ label: '実績', values: [3.2, null, 4.1] }]}
				ariaLabel="ROASの推移グラフ"
			/>,
		);

		const graph = screen.getByLabelText('ROASの推移グラフ');
		expect(graph.querySelectorAll('circle')).toHaveLength(2);
		expect(graph.querySelectorAll('polyline')).toHaveLength(2);
	});
});
