import React from 'react';
import { render } from '@testing-library/react';
import CreateNewsPage from '@/app/admin/news/create/page';

const mockNewsForm = jest.fn((props: Record<string, unknown>) => {
  void props;
  return <div data-testid="news-form" />;
});

jest.mock('@/app/admin/news/NewsForm', () => ({
  NewsForm: (props: Record<string, unknown>) => mockNewsForm(props),
}));

describe('CreateNewsPage', () => {
  beforeEach(() => {
    mockNewsForm.mockClear();
  });

  it('DD-NEWS-062 NewsForm に作成の送り先 /api/admin/news と POST を渡し、初めの値を渡さない', () => {
    const { getByTestId } = render(<CreateNewsPage />);

    expect(getByTestId('news-form')).toBeInTheDocument();
    expect(mockNewsForm).toHaveBeenCalledTimes(1);
    const props = mockNewsForm.mock.calls[0][0];
    expect(props).toEqual({ submitUrl: '/api/admin/news', submitMethod: 'POST' });
    expect(props).not.toHaveProperty('initialValues');
    expect(props).not.toHaveProperty('existingImageUrl');
  });
});
