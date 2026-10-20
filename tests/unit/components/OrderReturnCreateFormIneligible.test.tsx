import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ORDER_ID, jsonResponse, reviewMaterials } from './return-review-test-fixtures';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnCreateForm from '@/components/OrderReturnCreateForm';

const TITLE = '返品を作る（ORD-A1B2C3D4）';

/** シルクブラウス（白 / M）は返品不可、ウールパンツ（2）は返品できる。どちらも返品できる数がある */
function materialsWithIneligibleBlouse() {
  const base = reviewMaterials();
  const [shipment] = base.shipments;
  const [blouse] = shipment.lines;
  return {
    ...base,
    shipments: [
      {
        ...shipment,
        lines: [
          { ...blouse, returnable: 2, returnIneligible: true },
          {
            ...blouse,
            orderItemId: 'item-pants',
            itemId: 12,
            variantId: 201,
            itemName: 'ウールパンツ',
            color: null,
            size: '2',
            quantity: 1,
            returnable: 1,
            returnIneligible: false,
          },
        ],
      },
    ],
  };
}

async function openForm() {
  mockClientFetch.mockResolvedValueOnce(jsonResponse({ data: materialsWithIneligibleBlouse() }));
  render(<OrderReturnCreateForm orderId={ORDER_ID} onClose={jest.fn()} onCreated={jest.fn()} />);
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return dialog;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnCreateForm の返品不可の品の警告', () => {
  it('返品不可の品の行にだけ「返品不可の品です」を出す', async () => {
    const dialog = await openForm();

    const blouse = within(dialog).getByRole('group', { name: 'シルクブラウス（白 / M）' });
    const pants = within(dialog).getByRole('group', { name: 'ウールパンツ（2）' });
    expect(within(blouse).getByText('返品不可の品です')).toBeInTheDocument();
    expect(within(pants).queryByText('返品不可の品です')).not.toBeInTheDocument();
  });

  it('警告は止めない: 数を入れれば作れ、数を入れた後も警告は出たまま', async () => {
    const dialog = await openForm();
    const blouse = within(dialog).getByRole('group', { name: 'シルクブラウス（白 / M）' });

    fireEvent.change(within(blouse).getByLabelText('返品する数'), { target: { value: '1' } });

    expect(within(blouse).getByText('返品不可の品です')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '返品を作る' })).toBeEnabled();
  });
});
