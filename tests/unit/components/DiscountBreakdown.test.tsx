import React from 'react';
import { render, screen } from '@testing-library/react';
import { DiscountBreakdown } from '@/components/DiscountBreakdown';

const effect = (name: string, amount: number, code: string | null = null) => ({ name, code, amount });

describe('DiscountBreakdown', () => {
  test('FREQ-550-AC-01: 正額の効果を１効果１行で「割引（名前） −¥金額」と出し、0円は出さない', () => {
    render(<DiscountBreakdown effects={[effect('春の割引', 1000), effect('商品の割引', 2500), effect('ゼロ', 0)]} showCodes={false} />);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('割引（春の割引） −¥1,000');
    expect(rows[1]).toHaveTextContent('割引（商品の割引） −¥2,500');
    expect(screen.queryByText(/ゼロ/)).toBeNull();
  });

  test('FREQ-550-AC-01: 正額がなければ何も描画しない', () => {
    const { container } = render(<DiscountBreakdown effects={[effect('ゼロ', 0)]} showCodes />);
    expect(container).toBeEmptyDOMElement();
  });

  test('FREQ-550-AC-01: codeはshowCodesがtrueで入力済みの時だけ出し、自動割引には出さない', () => {
    const effects = [effect('コード割引', 500, 'SPRING10'), effect('自動割引', 300)];
    const { rerender } = render(<DiscountBreakdown effects={effects} showCodes />);
    expect(screen.getByText('SPRING10')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[1]).not.toHaveTextContent('SPRING10');

    rerender(<DiscountBreakdown effects={effects} showCodes={false} />);
    expect(screen.queryByText('SPRING10')).toBeNull();
  });

  test('FREQ-548-AC-02: provisionalの行には「見込み」を付け、確定の行には付けない', () => {
    const { rerender } = render(<DiscountBreakdown effects={[effect('初回の割引', 700)]} showCodes={false} provisional />);
    expect(screen.getByText('見込み')).toBeInTheDocument();

    rerender(<DiscountBreakdown effects={[effect('初回の割引', 700)]} showCodes={false} />);
    expect(screen.queryByText('見込み')).toBeNull();
  });

  test('FREQ-550-AC-03: 名前にHTMLが入っていても実行せず文字として出す', () => {
    const { container } = render(<DiscountBreakdown effects={[effect('<img src=x onerror=alert(1)>', 100)]} showCodes={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });
});
