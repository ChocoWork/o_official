import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
