import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ItemForm } from '@/app/admin/item/ItemForm';
import { clientFetch } from '@/lib/client-fetch';

/**
 * 商品フォームの保存済みカラーの削除が 429 で断られた時（波 4 Task 1b）。
 * 回数の制限の 429 は no-store で返る。本文を使わなくても読み始めないと、ブラウザが要求を開いたまま残す。
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const COLOR_PRESET = { id: 1, name: 'Ivory', hex: '#fffff0', created_at: '2026-10-01T00:00:00.000Z' };

let getContextSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  mockClientFetch.mockReset();
  // jsdom は canvas の getContext を実装しておらず雑音が出るので、動きを変えずに null を返す
  getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  getContextSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('ItemForm の保存済みカラーの削除', () => {
  it('429（本文は使わない）で断られても、本文を読み始めて失敗の文を出す', async () => {
    const drain = jest.fn(async () => new ArrayBuffer(0));
    mockClientFetch.mockImplementation(async (endpoint, init) => {
      if (endpoint === '/api/admin/item-color-presets' && !init?.method) {
        return { ok: true, status: 200, json: async () => ({ data: [COLOR_PRESET] }) } as Response;
      }
      return { ok: false, status: 429, json: async () => ({}), arrayBuffer: drain } as unknown as Response;
    });
    render(<ItemForm submitUrl="/api/admin/items" submitMethod="POST" />);
    await screen.findByText('保存済みカラー');

    fireEvent.click(await screen.findByRole('button', { name: '保存済みカラーを削除' }));

    expect(await screen.findByText('保存済みカラーの削除に失敗しました')).toBeInTheDocument();
    await waitFor(() => expect(drain).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/item-color-presets/1', { method: 'DELETE' });
  });
});
