/** 削除できない商品の案内（R-44）。管理画面と API で同じ文を使う */
export function buildItemDeleteGuidance(reasons: string[]): string {
  const detail = reasons.length > 0 ? `（${reasons.join('・')}）` : '';
  return `この商品は削除できません${detail}。非公開にすると、お客様の画面から見えなくなります。`;
}
