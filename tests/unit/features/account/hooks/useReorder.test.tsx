import { act, renderHook } from '@testing-library/react';
import { useReorder } from '@/features/account/hooks/useReorder';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ITEM = { id: 'order-item-1', itemId: 45, variantId: 1201, quantity: 2 };

describe('useReorder', () => {
  const onSuccess = jest.fn();
  const onError = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    document.cookie = 'sb-csrf-token=; max-age=0';
    global.fetch = jest.fn();
  });

  async function reorder(item: Parameters<ReturnType<typeof useReorder>['reorder']>[0]) {
    const { result } = renderHook(() => useReorder({ onSuccess, onError }));
    await act(async () => {
      await result.current.reorder(item);
    });
    return result;
  }

  test('注文の明細のバリアントの番号と数量を /api/cart/add に送り、成功を伝える', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [] }));

    const result = await reorder(ITEM);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('/api/cart/add');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ items: [{ id: 1201, quantity: 2 }] });
    expect(onSuccess).toHaveBeenCalledWith('カートに追加しました');
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.reorderingItemId).toBeNull();
  });

  test('バリアントの番号が無い古い明細は送らずに、お求めいただけないと伝える', async () => {
    await reorder({ ...ITEM, variantId: null });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('この商品は現在お求めいただけません。');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test('取り扱いが終わった色・サイズ（404）は、お求めいただけないと伝える', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(404, { status: 404, message: 'Cart Error', description: '選んだ色・サイズは現在お求めいただけません。' }),
    );

    await reorder(ITEM);

    expect(onError).toHaveBeenCalledWith('この商品は現在お求めいただけません。');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test('窓口の断り（422）は description をそのまま伝える', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse(422, { status: 422, message: 'Cart Error', description: '1つの商品は20個までです。' }),
    );

    const result = await reorder(ITEM);

    expect(onError).toHaveBeenCalledWith('1つの商品は20個までです。');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.reorderingItemId).toBeNull();
  });

  test('通信が失敗した時は、追加に失敗したと伝える', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await reorder(ITEM);

    expect(onError).toHaveBeenCalledWith('カートへの追加に失敗しました');
    expect(result.current.reorderingItemId).toBeNull();
  });

  test('商品が削除されている明細（itemId が null）は何も送らず、何も伝えない', async () => {
    await reorder({ ...ITEM, itemId: null });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
