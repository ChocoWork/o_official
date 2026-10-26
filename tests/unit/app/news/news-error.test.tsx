import { fireEvent, render, screen } from '@testing-library/react';

import NewsError from '@/app/news/error';

function makeError(message: string, digest?: string) {
  const error = new Error(message) as Error & { digest?: string };
  error.digest = digest;
  return error;
}

describe('NewsError', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('DD-NEWS-069 見出しと「エラー」を含む案内を出す', () => {
    render(<NewsError error={makeError('x')} retry={jest.fn()} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'NEWS を読み込めませんでした' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('エラー');
    expect(
      screen.getByText('一時的なエラーのため表示できません。しばらくしてからもう一度お試しください。'),
    ).toBeInTheDocument();
  });

  it('DD-NEWS-069 error.message を画面に出さない', () => {
    const { container } = render(
      <NewsError error={makeError('SECRET_DB_DETAIL')} retry={jest.fn()} />,
    );

    expect(container).not.toHaveTextContent('SECRET_DB_DETAIL');
  });

  it('DD-NEWS-069 ボタンを押すと retry を 1 回呼ぶ', () => {
    const retry = jest.fn();
    render(<NewsError error={makeError('x')} retry={retry} />);

    fireEvent.click(screen.getByRole('button'));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('DD-NEWS-069 console.error には digest だけを渡し、message・stack を渡さない', () => {
    const error = makeError('SECRET_DB_DETAIL', 'digest-1');
    render(<NewsError error={error} retry={jest.fn()} />);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    expect(args.slice(1)).toEqual([{ digest: 'digest-1' }]);
    expect(JSON.stringify(args)).not.toContain('SECRET_DB_DETAIL');
    expect(args).not.toContain(error);
    expect(args).not.toContain(error.stack);
  });
});
