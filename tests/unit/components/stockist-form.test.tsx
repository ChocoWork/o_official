import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StockistForm } from '@/app/admin/stockist/StockistForm';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const INITIAL_VALUES = {
  name: '渋谷店',
  address: '東京都渋谷区1-1-1',
  phone: '03-0000-0001',
  time: '11:00-19:00',
  holiday: '水曜日',
  status: 'published' as const,
};

const OTHER_VALUES = {
  name: '大阪店',
  address: '大阪府大阪市2-2-2',
  phone: '06-0000-0002',
  time: '12:00-20:00',
  holiday: '火曜日',
  status: 'private' as const,
};

const FIELD_LABELS = ['店舗名', '住所', '電話番号', '営業時間', '定休日'] as const;

function okResponse(body: unknown = {}): Response {
  return { ok: true, json: async () => body } as Response;
}

function ngResponse(body: unknown): Response {
  return { ok: false, json: async () => body } as Response;
}

function brokenJsonResponse(ok: boolean): Response {
  return {
    ok,
    json: async () => {
      throw new SyntaxError('not json');
    },
  } as unknown as Response;
}

function getField(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
}

function fillAll(values: Record<(typeof FIELD_LABELS)[number], string>) {
  FIELD_LABELS.forEach((label) => {
    fireEvent.change(getField(label), { target: { value: values[label] } });
  });
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector('form') as HTMLFormElement;
  fireEvent.submit(form);
}

const VALID_VALUES = {
  店舗名: '新店',
  住所: '京都府京都市3-3-3',
  電話番号: '075-0000-0003',
  営業時間: '10:00-18:00',
  定休日: '木曜日',
};

describe('StockistForm', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockClientFetch.mockReset();
    mockPush.mockReset();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('DD-STOCKIST-031 initialValues なしで欄が空、公開状態が「非公開」、ボタンが「保存」になる', () => {
    render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);

    FIELD_LABELS.forEach((label) => {
      expect(getField(label)).toHaveValue('');
    });
    expect(screen.getByRole('combobox')).toHaveTextContent('非公開');
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    expect(screen.queryByText('読み込み中...')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-031 initialValues ありで6つの値が欄に入り、PUT のボタンが「更新」になる', () => {
    render(
      <StockistForm submitUrl="/api/admin/stockists/1" submitMethod="PUT" initialValues={INITIAL_VALUES} />,
    );

    expect(getField('店舗名')).toHaveValue('渋谷店');
    expect(getField('住所')).toHaveValue('東京都渋谷区1-1-1');
    expect(getField('電話番号')).toHaveValue('03-0000-0001');
    expect(getField('営業時間')).toHaveValue('11:00-19:00');
    expect(getField('定休日')).toHaveValue('水曜日');
    expect(screen.getByRole('combobox')).toHaveTextContent('公開');
    expect(screen.getByRole('combobox')).not.toHaveTextContent('非公開');
    expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
  });

  it('DD-STOCKIST-031 描いた後に initialValues を変えると6つの値が入れ替わる', () => {
    const { rerender } = render(
      <StockistForm submitUrl="/api/admin/stockists/1" submitMethod="PUT" initialValues={INITIAL_VALUES} />,
    );

    rerender(
      <StockistForm submitUrl="/api/admin/stockists/1" submitMethod="PUT" initialValues={OTHER_VALUES} />,
    );

    expect(getField('店舗名')).toHaveValue('大阪店');
    expect(getField('住所')).toHaveValue('大阪府大阪市2-2-2');
    expect(getField('電話番号')).toHaveValue('06-0000-0002');
    expect(getField('営業時間')).toHaveValue('12:00-20:00');
    expect(getField('定休日')).toHaveValue('火曜日');
    expect(screen.getByRole('combobox')).toHaveTextContent('非公開');
  });

  it('DD-STOCKIST-031 initialValues が無いまま描き直しても入力中の値を消さない', () => {
    const { rerender } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fireEvent.change(getField('店舗名'), { target: { value: '入力中の店' } });

    rerender(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);

    expect(getField('店舗名')).toHaveValue('入力中の店');
  });

  it('DD-STOCKIST-031 公開状態を「公開」に変えて送ると本文の status が published になる', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse());
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: '公開' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('公開');
    submitForm(container);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));
    const [, init] = mockClientFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string).status).toBe('published');
  });

  it('DD-STOCKIST-031 公開状態を変えずに送ると本文の status が private になる', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse());
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));
    const [, init] = mockClientFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string).status).toBe('private');
  });

  it.each(FIELD_LABELS)(
    'DD-STOCKIST-031 %s が空白だけの時は「必須項目を入力してください」を出して送らない',
    (label) => {
      const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
      fillAll(VALID_VALUES);
      fireEvent.change(getField(label), { target: { value: '   ' } });

      submitForm(container);

      expect(screen.getByText('必須項目を入力してください')).toBeInTheDocument();
      expect(mockClientFetch).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    },
  );

  it('DD-STOCKIST-031 全部の欄が空の時も「必須項目を入力してください」を出して送らない', () => {
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);

    submitForm(container);

    expect(screen.getByText('必須項目を入力してください')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-031 誤りの後に正しく送り直すと前の誤りの文が消える', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse());
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    submitForm(container);
    expect(screen.getByText('必須項目を入力してください')).toBeInTheDocument();

    fillAll(VALID_VALUES);
    submitForm(container);

    await waitFor(() => expect(screen.getByText('STOCKISTを保存しました')).toBeInTheDocument());
    expect(screen.queryByText('必須項目を入力してください')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-031 送る本文が前後の空白を除いた値で、方法が submitMethod、見出しに Content-Type: application/json が付く', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse());
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists/9" submitMethod="PUT" />);
    fillAll({
      店舗名: '  新店  ',
      住所: ' 京都府京都市3-3-3 ',
      電話番号: '\t075-0000-0003\t',
      営業時間: ' 10:00-18:00',
      定休日: '木曜日 ',
    });

    submitForm(container);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/stockists/9', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '新店',
        address: '京都府京都市3-3-3',
        phone: '075-0000-0003',
        time: '10:00-18:00',
        holiday: '木曜日',
        status: 'private',
      }),
    });
  });

  it('DD-STOCKIST-031 送る間はボタンが「保存中...」で押せず、終わると戻る', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    mockClientFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    const pending = await screen.findByRole('button', { name: '保存中...' });
    expect(pending).toBeDisabled();

    resolveFetch(okResponse());
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled());
  });

  it('DD-STOCKIST-031 POST の成功で「STOCKISTを保存しました」を出し /admin?tab=STOCKIST へ移る', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse());
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    expect(await screen.findByText('STOCKISTを保存しました')).toBeInTheDocument();
    expect(screen.queryByText('STOCKISTを更新しました')).not.toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST');
  });

  it('DD-STOCKIST-031 PUT の成功で「STOCKISTを更新しました」を出し /admin?tab=STOCKIST へ移る', async () => {
    mockClientFetch.mockResolvedValueOnce(okResponse());
    const { container } = render(
      <StockistForm submitUrl="/api/admin/stockists/1" submitMethod="PUT" initialValues={INITIAL_VALUES} />,
    );

    submitForm(container);

    expect(await screen.findByText('STOCKISTを更新しました')).toBeInTheDocument();
    expect(screen.queryByText('STOCKISTを保存しました')).not.toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST');
  });

  it('DD-STOCKIST-031 応答がOKでなく error がある時はその文を出し、移らない', async () => {
    mockClientFetch.mockResolvedValueOnce(ngResponse({ error: '権限がありません' }));
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    expect(await screen.findByText('権限がありません')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.queryByText('STOCKISTを保存しました')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('DD-STOCKIST-031 応答がOKでなく error が無い時は「STOCKISTの保存に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(ngResponse({}));
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    expect(await screen.findByText('STOCKISTの保存に失敗しました')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-031 応答がOKでなく本文がJSONでない時は「STOCKISTの保存に失敗しました」を出す', async () => {
    mockClientFetch.mockResolvedValueOnce(brokenJsonResponse(false));
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    expect(await screen.findByText('STOCKISTの保存に失敗しました')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('DD-STOCKIST-031 応答がOKで本文がJSONでない時も成功の文を出して移る', async () => {
    mockClientFetch.mockResolvedValueOnce(brokenJsonResponse(true));
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    expect(await screen.findByText('STOCKISTを保存しました')).toBeInTheDocument();
    expect(mockPush).toHaveBeenCalledWith('/admin?tab=STOCKIST');
  });

  it('DD-STOCKIST-031 clientFetch が例外を投げた時は通信の誤りの文を出し、ボタンが戻る', async () => {
    mockClientFetch.mockRejectedValueOnce(new Error('network down'));
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);
    fillAll(VALID_VALUES);

    submitForm(container);

    expect(
      await screen.findByText('通信エラーが発生しました。時間をおいて再度お試しください'),
    ).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith('Failed to submit stockist:', expect.any(Error));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('DD-STOCKIST-031 isLoading を真で渡すと「読み込み中...」だけが出てフォームは出ない', () => {
    const { container } = render(
      <StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" isLoading />,
    );

    expect(screen.getByText('読み込み中...')).toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('DD-STOCKIST-031 isLoading を渡さない時はフォームを出す', () => {
    const { container } = render(<StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />);

    expect(container.querySelector('form')).not.toBeNull();
    expect(within(container).queryByText('読み込み中...')).not.toBeInTheDocument();
  });
});
