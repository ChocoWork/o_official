import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminItemEditPage from '@/app/admin/item/edit/[id]/page';
import { ItemForm } from '@/app/admin/item/ItemForm';
import type { ItemFormValues, ItemResponse } from '@/app/admin/item/types';
import { clientFetch } from '@/lib/client-fetch';

/**
 * 商品の編集の「返品不可」のチェック（グループ E-3 段2 P15）。
 * チェックの最初の値（作る画面はオフ、直す画面は窓口の答えの return_ineligible）と、保存で FormData に入れる return_ineligible を確かめる。
 */

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: '7' }),
}));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
// 色・サイズごとの在庫の欄は別の部品で、この試験の対象ではない（直す画面の読み込みの試験で、読み込みに行かせない）
jest.mock('@/app/admin/item/ItemStockSection', () => ({ ItemStockSection: () => null }));

const mockClientFetch = clientFetch as jest.MockedFunction<typeof clientFetch>;

const LABEL = '返品不可（お客様のご都合による返品・交換を受けない）';
const checkbox = () => screen.getByRole('checkbox', { name: LABEL });

/** 色の保存済みの一覧に1件。読み込みが終わると、画面に `保存済みカラー` が出る */
const COLOR_PRESET = { id: 1, name: 'Ivory', hex: '#fffff0', created_at: '2026-10-01T00:00:00.000Z' };

/** 保存に必要な項目が全部そろった、直す画面の最初の値 */
const VALUES: ItemFormValues = {
  name: 'ウールジャケット',
  description: '厚手のウールを使った、すっきりしたシルエットのジャケットです。',
  price: 38000,
  category: 'OUTERWEAR',
  colors: [{ name: 'Black', hex: '#000000' }],
  sizes: ['M'],
  material: 'Wool 100%',
  origin: 'Japan',
  care: 'ドライクリーニング',
  productNote: '',
  status: 'published',
  previewUrls: ['https://example.test/item-1.jpg'],
};

/** 管理画面の窓口の商品の答え（data の中身） */
const ITEM: ItemResponse = {
  id: 7,
  name: 'ウールジャケット',
  description: '厚手のウールを使った、すっきりしたシルエットのジャケットです。',
  price: 38000,
  category: 'OUTERWEAR',
  image_url: 'https://example.test/item-1.jpg',
  image_urls: ['https://example.test/item-1.jpg'],
  colors: [{ name: 'Black', hex: '#000000' }],
  sizes: ['M'],
  product_details: '',
  status: 'published',
};

function answer(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** 窓口を用意する。色の一覧は1件、商品の読み込みは item を渡した時だけ、保存は成功で返す */
function serve(item?: Partial<ItemResponse>) {
  mockClientFetch.mockImplementation(async (endpoint) => {
    if (endpoint === '/api/admin/item-color-presets') {
      return answer({ data: [COLOR_PRESET] });
    }
    if (item && endpoint === '/api/admin/items/7') {
      return answer({ data: { ...ITEM, ...item } });
    }
    return answer({ success: true });
  });
}

/** 部品を描き、色の保存済みの一覧を読み終えるまで待つ。既定は、必要な項目がそろった直す画面 */
async function renderForm(props: Partial<React.ComponentProps<typeof ItemForm>> = {}) {
  const view = render(<ItemForm submitUrl="/api/admin/items/7" submitMethod="PUT" initialValues={VALUES} {...props} />);
  await screen.findByText('保存済みカラー');
  return view;
}

/** 窓口へ送った FormData（本文が FormData の呼び出し） */
function sentFormData(): FormData {
  const call = mockClientFetch.mock.calls.find(([, init]) => init?.body instanceof FormData);
  return call?.[1]?.body as FormData;
}

/** 保存を押し、送り終えるまで待って、窓口へ送った FormData を返す */
async function submitAndRead(container: HTMLElement): Promise<FormData> {
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/admin?tab=ITEM'));
  // 送り終えた後の画面の更新（「更新中...」「保存中...」を戻す）まで待つ
  await waitFor(() => expect(screen.queryByText(/中\.\.\./)).not.toBeInTheDocument());
  return sentFormData();
}

// jsdom は canvas の getContext を実装しておらず、呼ぶたびに「Not implemented」を console.error に出す（SingleSelect が文字の幅を測るために呼ぶ）。
// jsdom の答えも null で、SingleSelect は null なら何もせず戻るので、動きは変えずに null を返す差し替えにして雑音だけを消す。試験の終わりに元へ戻す
let getContextSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  serve();
});

afterEach(() => {
  getContextSpy.mockRestore();
});

describe('ItemForm の返品不可のチェック', () => {
  it('作る画面（最初の値なし）では、「返品」の節にチェックを出し、オフにしておく', async () => {
    await renderForm({ submitUrl: '/api/admin/items', submitMethod: 'POST', initialValues: undefined });

    expect(screen.getByRole('heading', { level: 2, name: '返品' })).toBeInTheDocument();
    expect(checkbox()).not.toBeChecked();
  });

  it.each<[string, boolean, Partial<ItemFormValues>]>([
    ['returnIneligible が true', true, { returnIneligible: true }],
    ['returnIneligible が false', false, { returnIneligible: false }],
    ['returnIneligible が無い', false, {}],
  ])('直す画面で最初の値が「%s」の時、チェックの状態は %s', async (_label, checked, extra) => {
    await renderForm({ initialValues: { ...VALUES, ...extra } });

    expect(checkbox()).toHaveProperty('checked', checked);
  });

  it('チェックを入れて保存すると、FormData の return_ineligible に "true" を1つだけ入れて送る。ほかの項目は今までどおり', async () => {
    const { container } = await renderForm();
    fireEvent.click(checkbox());
    expect(checkbox()).toBeChecked();

    const body = await submitAndRead(container);

    expect(body.getAll('return_ineligible')).toEqual(['true']);
    expect(body.get('name')).toBe(VALUES.name);
    expect(body.get('status')).toBe('published');
  });

  it('チェックを入れないで保存すると、"false" を送る（キーを省かない）', async () => {
    const { container } = await renderForm();

    const body = await submitAndRead(container);

    expect(body.getAll('return_ineligible')).toEqual(['false']);
  });

  it('印の付いた商品を開いてそのまま保存すると、"true" を送る', async () => {
    const { container } = await renderForm({ initialValues: { ...VALUES, returnIneligible: true } });
    expect(checkbox()).toBeChecked();

    const body = await submitAndRead(container);

    expect(body.getAll('return_ineligible')).toEqual(['true']);
  });

  it('印の付いた商品を開いてチェックを外して保存すると、"false" を送る', async () => {
    const { container } = await renderForm({ initialValues: { ...VALUES, returnIneligible: true } });
    fireEvent.click(checkbox());
    expect(checkbox()).not.toBeChecked();

    const body = await submitAndRead(container);

    expect(body.getAll('return_ineligible')).toEqual(['false']);
  });

  it('作る画面の保存（POST）も、return_ineligible を送る', async () => {
    const { container } = await renderForm({ submitUrl: '/api/admin/items', submitMethod: 'POST' });
    fireEvent.click(checkbox());

    const body = await submitAndRead(container);

    expect(body.getAll('return_ineligible')).toEqual(['true']);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/items', expect.objectContaining({ method: 'POST' }));
  });
});

describe('商品の編集の画面の読み込み（AdminItemEditPage）の返品不可', () => {
  it.each<[string, boolean, Partial<ItemResponse>]>([
    ['return_ineligible が true', true, { return_ineligible: true }],
    ['return_ineligible が false', false, { return_ineligible: false }],
    ['return_ineligible が無い（窓口の古い答え）', false, {}],
  ])('管理画面の窓口の答え（%s）を、チェックの最初の値にする。チェックの状態は %s', async (_label, checked, item) => {
    serve(item);
    render(<AdminItemEditPage />);

    const box = await screen.findByRole('checkbox', { name: LABEL });
    await screen.findByText('保存済みカラー');

    expect(box).toHaveProperty('checked', checked);
  });

  it('読み込んだ印のまま保存すると、return_ineligible に "true" を送る', async () => {
    serve({ return_ineligible: true });
    const { container } = render(<AdminItemEditPage />);
    await screen.findByText('保存済みカラー');

    const body = await submitAndRead(container);

    expect(body.getAll('return_ineligible')).toEqual(['true']);
    expect(mockClientFetch).toHaveBeenCalledWith('/api/admin/items/7', expect.objectContaining({ method: 'PUT' }));
  });
});
