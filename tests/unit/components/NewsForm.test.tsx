import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewsForm } from '@/app/admin/news/NewsForm';

/**
 * FREQ-252: Admin の News 管理で画像アップロードを行う。
 * （FREQ-33「画像アップロードを行わない」を廃止して置き換え）
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/client-fetch', () => ({
  clientFetch: jest.fn(),
}));

import { clientFetch } from '@/lib/client-fetch';

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const EDIT_VALUES = {
  title: 'テスト',
  category: 'COLLECTION' as const,
  date: '2026-01-01',
  content: '要約',
  detailedContent: '詳細',
  status: 'published' as const,
};

function makeFile(name: string, type: string, size = 1024) {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('NewsForm 画像アップロード (FREQ-252)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('作成モード: 画像アップロード欄が存在する', () => {
    // FREQ-252-AC-01
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    expect(screen.getByText('画像')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('編集モード: 画像アップロード欄が存在する', () => {
    // FREQ-252-AC-01
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    expect(screen.getByText('画像')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  test('受け付ける MIME を accept で制限する', () => {
    // FREQ-252-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    expect(container.querySelector('input[type="file"]')).toHaveAttribute(
      'accept',
      'image/jpeg,image/png,image/webp,image/gif',
    );
  });

  test('対象外の MIME は受け付けない', async () => {
    // FREQ-252-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const input = container.querySelector('input[type="file"]')!;

    fireEvent.change(input, { target: { files: [makeFile('a.pdf', 'application/pdf')] } });

    expect(
      await screen.findByText('画像は JPEG / PNG / WebP / GIF を選択してください'),
    ).toBeInTheDocument();
  });

  test('5MB を超える画像は受け付けない', async () => {
    // FREQ-252-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    const input = container.querySelector('input[type="file"]')!;

    fireEvent.change(input, {
      target: { files: [makeFile('big.png', 'image/png', 6 * 1024 * 1024)] },
    });

    expect(await screen.findByText('画像サイズは5MB以下にしてください')).toBeInTheDocument();
  });

  test('作成モードは画像必須で、未添付なら送信しない', async () => {
    // FREQ-252-AC-02
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);

    fireEvent.submit(container.querySelector('form')!);

    expect(await screen.findByText('画像を添付してください')).toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });

  test('編集モードは画像未選択でも送信できる', async () => {
    // FREQ-252-AC-02
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled());
    expect(screen.queryByText('画像を添付してください')).not.toBeInTheDocument();
  });
});

describe('NewsForm のカテゴリーの選択欄（FREQ-515）', () => {
  // jsdom は canvas の getContext を実装せず「Not implemented」を console.error に出す（SingleSelect が文字の幅を測るために呼ぶ）。
  // jsdom の答えも null なので、動きは変えずに null を返す差し替えにして雑音だけを消す
  let getContextSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    mockClientFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  });

  afterEach(() => {
    getContextSpy.mockRestore();
  });

  async function chooseCategory(label: string) {
    const user = userEvent.setup();
    const combobox = screen.getByRole('combobox', { name: 'カテゴリー' });
    await user.click(combobox);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: label }));
    expect(combobox).toHaveTextContent(label);
  }

  async function submittedCategory(container: HTMLElement) {
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalled());
    const body = mockClientFetch.mock.calls[0][1]?.body as FormData;
    return body.get('category');
  }

  test('作成モード: 選んだカテゴリーを送る', async () => {
    // FREQ-515-AC-03
    const { container } = render(<NewsForm submitUrl="/api/admin/news" submitMethod="POST" />);
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [makeFile('a.png', 'image/png')] },
    });

    await chooseCategory('EVENT');

    expect(await submittedCategory(container)).toBe('EVENT');
  });

  test('編集モード: 選んだカテゴリーを送る', async () => {
    // FREQ-515-AC-03
    const { container } = render(
      <NewsForm submitUrl="/api/admin/news/1" submitMethod="PUT" initialValues={EDIT_VALUES} />,
    );

    await chooseCategory('STORE');

    expect(await submittedCategory(container)).toBe('STORE');
  });
});
