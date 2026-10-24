import React from 'react';
import { render, screen } from '@testing-library/react';
import AdminLookCreatePage from '@/app/admin/look/create/page';

const mockLookForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="look-form" />;
});

jest.mock('@/app/admin/look/LookForm', () => ({
  LookForm: (props: Record<string, unknown>) => mockLookForm(props),
}));

describe('AdminLookCreatePage', () => {
  beforeEach(() => {
    mockLookForm.mockClear();
  });

  it('DD-LOOK-061 LookForm に送り先 /api/admin/looks・送り方 POST を渡し初めの値は渡さない', () => {
    render(<AdminLookCreatePage />);

    expect(screen.getByTestId('look-form')).toBeInTheDocument();
    expect(mockLookForm).toHaveBeenCalledTimes(1);
    const props = mockLookForm.mock.calls[0][0];
    expect(props).toEqual({
      submitUrl: '/api/admin/looks',
      submitMethod: 'POST',
    });
    expect(props).not.toHaveProperty('initialValues');
  });
});
