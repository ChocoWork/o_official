import { fireEvent, render, screen } from '@testing-library/react';
import OrderShipDialog from '@/components/OrderShipDialog';

function renderDialog(onSubmit = jest.fn()) {
  const utils = render(<OrderShipDialog open onClose={jest.fn()} onSubmit={onSubmit} />);
  return { ...utils, onSubmit };
}

describe('OrderShipDialog', () => {
  it('「お客様に発送のメールを送る」は最初から入っている', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: '発送済みにする' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
  });

  it('外すと「送らない」で発送する', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText('配送業者'), { target: { value: 'sagawa' } });
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: ' 1234-5678 ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(screen.getByRole('button', { name: '発送する' }));

    expect(onSubmit).toHaveBeenCalledWith({ carrier: 'sagawa', trackingNumber: '1234-5678', notifyCustomer: false });
  });

  it('追跡番号の形が違えば、画面の中で知らせて送らない', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: '12 34' } });
    fireEvent.click(screen.getByRole('button', { name: '発送する' }));

    expect(screen.getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('開き直すと既定（ヤマト・空・送る）へ戻す', () => {
    const { rerender } = render(<OrderShipDialog open onClose={jest.fn()} onSubmit={jest.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    rerender(<OrderShipDialog open={false} onClose={jest.fn()} onSubmit={jest.fn()} />);
    rerender(<OrderShipDialog open onClose={jest.fn()} onSubmit={jest.fn()} />);

    expect(screen.getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
    expect(screen.getByLabelText('追跡番号')).toHaveValue('');
  });

  it('配送業者と追跡番号を変えて閉じ、開き直すと、既定（ヤマト・空）へ戻り、誤りの文も消える', () => {
    const { rerender } = render(<OrderShipDialog open onClose={jest.fn()} onSubmit={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('配送業者'), { target: { value: 'japanpost' } });
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: '12 34' } });
    fireEvent.click(screen.getByRole('button', { name: '発送する' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<OrderShipDialog open={false} onClose={jest.fn()} onSubmit={jest.fn()} />);
    rerender(<OrderShipDialog open onClose={jest.fn()} onSubmit={jest.fn()} />);

    expect(screen.getByLabelText('配送業者')).toHaveValue('yamato');
    expect(screen.getByLabelText('追跡番号')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('既定のまま送ると、配送業者はヤマトで、お客様へのメールは「送る」になる', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: '1234-5678-9012' } });
    fireEvent.click(screen.getByRole('button', { name: '発送する' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ carrier: 'yamato', trackingNumber: '1234-5678-9012', notifyCustomer: true });
  });

  it('「キャンセル」では送らずに閉じる', () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    render(<OrderShipDialog open onClose={onClose} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('追跡番号'), { target: { value: '1234-5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('追跡番号の欄は数字キーパッドに限らない（英字も打てる）', () => {
    renderDialog();

    expect(screen.getByLabelText('追跡番号')).not.toHaveAttribute('inputmode');
  });
});
