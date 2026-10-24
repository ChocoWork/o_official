import React from 'react';
import { render, screen } from '@testing-library/react';
import AdminStockistCreatePage from '@/app/admin/stockist/create/page';

const mockStockistForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="stockist-form" />;
});

jest.mock('@/app/admin/stockist/StockistForm', () => ({
  StockistForm: (props: Record<string, unknown>) => mockStockistForm(props),
}));

describe('AdminStockistCreatePage', () => {
  beforeEach(() => {
    mockStockistForm.mockClear();
  });

  it('DD-STOCKIST-032 StockistForm に送り先 /api/admin/stockists・送り方 POST を渡し初めの値は渡さない', () => {
    render(<AdminStockistCreatePage />);

    expect(screen.getByTestId('stockist-form')).toBeInTheDocument();
    expect(mockStockistForm).toHaveBeenCalledTimes(1);
    const props = mockStockistForm.mock.calls[0][0];
    expect(props).toEqual({
      submitUrl: '/api/admin/stockists',
      submitMethod: 'POST',
    });
    expect(props).not.toHaveProperty('initialValues');
  });
});
