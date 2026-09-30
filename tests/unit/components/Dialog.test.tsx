import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog } from '@/components/ui/Dialog/Dialog';

// Dialog は CSS ファイル方式へ移行済み。最大幅やボタン高さは CSS の責務なので、
// ここでは size の属性契約と、タイトル描画・バックドロップの閉じる動作を検証する。
describe('Dialog', () => {
  const dialogOf = (container: HTMLElement) => container.querySelector('[data-ui-dialog]');

  it('タイトルと既定のボタンを描画する', () => {
    render(<Dialog open onClose={() => {}} title="Hi" />);

    expect(screen.getByText('Hi')).toBeInTheDocument();
    expect(screen.getByText('CANCEL')).toBeInTheDocument();
    expect(screen.getByText('CONFIRM')).toBeInTheDocument();
  });

  it('size は data-ui-dialog-size に反映される', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { container } = render(<Dialog open onClose={() => {}} size={size} title="T" />);
      expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-size', size);
    }
  });

  it('size を切り替えると属性が追従する', () => {
    const { container, rerender } = render(<Dialog open onClose={() => {}} size="sm" title="T" />);
    expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-size', 'sm');

    rerender(<Dialog open onClose={() => {}} size="lg" title="T" />);
    expect(dialogOf(container)).toHaveAttribute('data-ui-dialog-size', 'lg');
  });

  it('バックドロップのクリックで onClose を呼ぶ', () => {
    const onClose = jest.fn();
    render(<Dialog open onClose={onClose} title="Test" />);

    fireEvent.click(document.querySelector('.dialog-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });
});

// aria-modal="true" を名乗る以上、フォーカスの移動・Tab の閉じ込め・Escape・戻し先まで面倒を見る。
// 管理画面の各ダイアログと同じく、親が描画のたびにつくり直す onClose を渡す使い方で確かめる。
function DialogHarness() {
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState('');

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        開く
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="確認">
        <button type="button">先頭</button>
        <textarea aria-label="メモ" value={memo} onChange={(event) => setMemo(event.target.value)} />
        <button type="button">末尾</button>
      </Dialog>
    </>
  );
}

function openHarness() {
  render(<DialogHarness />);
  const opener = screen.getByRole('button', { name: '開く' });
  opener.focus();
  fireEvent.click(opener);
  return { opener };
}

describe('Dialog のフォーカスの移動', () => {
  it('開くと、中で最初に操作できる要素へフォーカスが移る', () => {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <button type="button">先頭</button>
        <button type="button">末尾</button>
      </Dialog>,
    );

    expect(screen.getByRole('button', { name: '先頭' })).toHaveFocus();
  });

  it('既定のボタンだけのときは CANCEL へ移る', () => {
    render(<Dialog open onClose={jest.fn()} title="確認" />);

    expect(screen.getByRole('button', { name: 'CANCEL' })).toHaveFocus();
  });

  it('操作できる要素が無いときは、パネル自身（tabindex=-1）へ移る', () => {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <p>本文だけ</p>
      </Dialog>,
    );

    const panel = screen.getByRole('dialog', { name: '確認' });
    expect(panel).toHaveAttribute('tabindex', '-1');
    expect(panel).toHaveFocus();
  });

  it('無効・hidden・非表示の要素は最初の要素に数えない', () => {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <button type="button" disabled>
          無効
        </button>
        <button type="button" hidden>
          隠し
        </button>
        <button type="button" style={{ display: 'none' }}>
          非表示
        </button>
        <input aria-label="入力" />
      </Dialog>,
    );

    expect(screen.getByRole('textbox', { name: '入力' })).toHaveFocus();
  });

  it('すでに中にフォーカスがある（autoFocus）ときは奪わない', () => {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <button type="button">先頭</button>
        <input aria-label="入力" autoFocus />
      </Dialog>,
    );

    expect(screen.getByRole('textbox', { name: '入力' })).toHaveFocus();
  });
});

describe('Dialog の Tab の閉じ込め', () => {
  function renderThree() {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <button type="button">A</button>
        <input aria-label="B" />
        <button type="button">C</button>
      </Dialog>,
    );
    return {
      a: screen.getByRole('button', { name: 'A' }),
      b: screen.getByRole('textbox', { name: 'B' }),
      c: screen.getByRole('button', { name: 'C' }),
    };
  }

  it('最後の要素で Tab を押すと、最初の要素へ戻る', () => {
    const { a, c } = renderThree();
    c.focus();

    // fireEvent は既定の動作が止められたら false を返す
    expect(fireEvent.keyDown(c, { key: 'Tab' })).toBe(false);
    expect(a).toHaveFocus();
  });

  it('最初の要素で Shift+Tab を押すと、最後の要素へ移る', () => {
    const { a, c } = renderThree();
    a.focus();

    expect(fireEvent.keyDown(a, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(c).toHaveFocus();
  });

  it('途中の要素では Tab を奪わない（ブラウザの既定の動きに任せる）', () => {
    const { b } = renderThree();
    b.focus();

    expect(fireEvent.keyDown(b, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(b, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(b).toHaveFocus();
  });

  it('フォーカスが外へ出ていても、Tab で中へ戻す（背景の操作に届かせない）', () => {
    const { a, c } = renderThree();

    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(a).toHaveFocus();

    (document.activeElement as HTMLElement).blur();
    expect(fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(c).toHaveFocus();
  });

  it('無効・hidden の要素は端に数えない', () => {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <button type="button">A</button>
        <button type="button">B</button>
        <button type="button" disabled>
          無効
        </button>
        <button type="button" hidden>
          隠し
        </button>
      </Dialog>,
    );
    const b = screen.getByRole('button', { name: 'B' });
    b.focus();

    expect(fireEvent.keyDown(b, { key: 'Tab' })).toBe(false);
    expect(screen.getByRole('button', { name: 'A' })).toHaveFocus();
  });

  it('操作できる要素が無いときは、パネルに留める', () => {
    render(
      <Dialog open onClose={jest.fn()} title="確認">
        <p>本文だけ</p>
      </Dialog>,
    );
    const panel = screen.getByRole('dialog', { name: '確認' });

    expect(fireEvent.keyDown(panel, { key: 'Tab' })).toBe(false);
    expect(panel).toHaveFocus();
  });
});

describe('Dialog の Escape', () => {
  it('Escape で onClose を呼ぶ（フォーカスがどこにあっても）', () => {
    const onClose = jest.fn();
    render(
      <Dialog open onClose={onClose} title="確認">
        <input aria-label="入力" />
      </Dialog>,
    );

    fireEvent.keyDown(screen.getByRole('textbox', { name: '入力' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Escape 以外のキーでは閉じない', () => {
    const onClose = jest.fn();
    render(<Dialog open onClose={onClose} title="確認" />);

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('日本語入力の変換中の Escape では閉じない', () => {
    const onClose = jest.fn();
    render(
      <Dialog open onClose={onClose} title="確認">
        <input aria-label="入力" />
      </Dialog>,
    );

    fireEvent.keyDown(screen.getByRole('textbox', { name: '入力' }), { key: 'Escape', isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('中の部品が Escape を処理済み（preventDefault）なら閉じない', () => {
    const onClose = jest.fn();
    render(
      <Dialog open onClose={onClose} title="確認">
        <input
          aria-label="入力"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
            }
          }}
        />
      </Dialog>,
    );

    fireEvent.keyDown(screen.getByRole('textbox', { name: '入力' }), { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('閉じている間は Escape に反応しない', () => {
    const onClose = jest.fn();
    const { rerender } = render(<Dialog open onClose={onClose} title="確認" />);
    rerender(<Dialog open={false} onClose={onClose} title="確認" />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('閉じたら、キー入力の監視を外す（document に残さない）', () => {
    // 他のテストの取りこぼしに左右されないよう、登録と解除を直接見る
    const add = jest.spyOn(document, 'addEventListener');
    const remove = jest.spyOn(document, 'removeEventListener');
    try {
      const { rerender } = render(<Dialog open onClose={jest.fn()} title="確認" />);
      const handlers = add.mock.calls.filter(([type]) => type === 'keydown').map(([, handler]) => handler);
      expect(handlers).toHaveLength(1);

      rerender(<Dialog open={false} onClose={jest.fn()} title="確認" />);

      expect(remove).toHaveBeenCalledWith('keydown', handlers[0]);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe('Dialog を閉じたあとのフォーカス', () => {
  it('開く前にフォーカスがあった要素へ戻す', () => {
    const { opener } = openHarness();
    expect(screen.getByRole('button', { name: '先頭' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('開いた要素がもう文書に無いときは、フォーカスを戻そうとしない', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const focus = jest.spyOn(opener, 'focus');

    const { rerender } = render(
      <Dialog open onClose={jest.fn()} title="確認">
        <button type="button">先頭</button>
      </Dialog>,
    );
    opener.remove();
    rerender(<Dialog open={false} onClose={jest.fn()} title="確認" />);

    expect(focus).not.toHaveBeenCalled();
  });

  it('入力のたびに親が onClose をつくり直しても、フォーカスを奪い直さない', () => {
    openHarness();
    const memo = screen.getByRole('textbox', { name: 'メモ' });
    memo.focus();

    fireEvent.change(memo, { target: { value: 'あ' } });
    fireEvent.change(memo, { target: { value: 'あい' } });

    expect(memo).toHaveValue('あい');
    expect(memo).toHaveFocus();
  });
});

describe('Dialog の背景（スクリム）で閉じる条件', () => {
  const scrim = () => document.querySelector<HTMLElement>('.dialog-overlay__scrim')!;
  const overlay = () => document.querySelector<HTMLElement>('.dialog-overlay')!;

  function renderWithMemo() {
    const onClose = jest.fn();
    render(
      <Dialog open onClose={onClose} title="確認">
        <textarea aria-label="メモ" />
      </Dialog>,
    );
    return { onClose, memo: screen.getByRole('textbox', { name: 'メモ' }) };
  }

  it('背景で押して、そのまま背景で離すと閉じる', () => {
    const { onClose } = renderWithMemo();

    fireEvent.pointerDown(scrim());
    fireEvent.pointerUp(scrim());
    fireEvent.click(scrim());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('パネルの中で押して背景で離しても（文字の選択）、閉じない', () => {
    const { onClose, memo } = renderWithMemo();

    fireEvent.pointerDown(memo);
    fireEvent.pointerUp(scrim());
    // ブラウザは押した所と離した所の共通の親（overlay）へ click を送る
    fireEvent.click(overlay());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('背景で押してパネルの中で離しても、閉じない', () => {
    const { onClose, memo } = renderWithMemo();

    fireEvent.pointerDown(scrim());
    fireEvent.pointerUp(memo);
    fireEvent.click(overlay());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('パネルの中のクリックでは閉じない', () => {
    const { onClose, memo } = renderWithMemo();

    fireEvent.pointerDown(memo);
    fireEvent.pointerUp(memo);
    fireEvent.click(memo);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('前の押下の記録を引きずらない（パネルの中で押した後でも、次に背景を押せば閉じる）', () => {
    const { onClose, memo } = renderWithMemo();

    // 押しただけで click まで届かなかった（ウィンドウの外で離した等）
    fireEvent.pointerDown(memo);

    fireEvent.pointerDown(scrim());
    fireEvent.pointerUp(scrim());
    fireEvent.click(scrim());

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
