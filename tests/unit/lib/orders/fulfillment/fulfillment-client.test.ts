import * as fulfillmentClient from '@/lib/orders/fulfillment/fulfillment-client';
import { clampQuantity, lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';

// G-3 Task 7: 発送・仕上がりの窓口を呼ぶ停止の道具（callFulfillmentApi・fetchFulfillmentMaterials）と、その知らせの文は、発送票の窓口へ移って無くなった。
// 商品の見出しと数の入力の部品（返品・返金・取消の申し込みの画面が使う）だけが残る
describe('fulfillment-client の整理（G-3 Task 7）', () => {
  it('FREQ-534-AC-05: 窓口を呼ぶ停止の道具と仕上がりの知らせの文は無く、見出しと数の入力の部品だけが残る', () => {
    for (const name of ['callFulfillmentApi', 'fetchFulfillmentMaterials', 'COMPLETION_RECORDED_MESSAGE', 'NO_COMPLETION_QUANTITY_MESSAGE']) {
      expect(fulfillmentClient).not.toHaveProperty(name);
    }
    expect(Object.keys(fulfillmentClient).sort()).toEqual(['clampQuantity', 'lineLabel']);
  });
});

describe('lineLabel', () => {
  it('色とサイズを括弧に入れる。片方だけでも、どちらも無くても崩れない', () => {
    expect(lineLabel({ name: 'シルクブラウス', color: '白', size: 'M' })).toBe('シルクブラウス（白 / M）');
    expect(lineLabel({ name: 'シルクブラウス', color: null, size: 'M' })).toBe('シルクブラウス（M）');
    expect(lineLabel({ name: 'シルクブラウス', color: '白', size: null })).toBe('シルクブラウス（白）');
    expect(lineLabel({ name: 'シルクブラウス', color: null, size: null })).toBe('シルクブラウス');
  });
});

describe('clampQuantity', () => {
  it.each([
    ['2', 5, 2],
    ['9', 5, 5],
    ['0', 5, 0],
    ['-3', 5, 0],
    ['', 5, 0],
    ['abc', 5, 0],
    ['1.9', 5, 1],
    ['3', 0, 0],
  ])('%j（上限 %i）は %i にする', (raw, max, expected) => {
    expect(clampQuantity(raw, max)).toBe(expected);
  });
});
