import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockCheck = jest.fn();
const mockResize = jest.fn();
const mockUpload = jest.fn();
// 定数（受け付ける種類・画面の文）は Task 5 の物のまま使い、ファイルを確かめる・縮める・送る3つの関数だけを差し替える
jest.mock('@/lib/orders/returns/return-photo-client', () => ({
  ...jest.requireActual<typeof import('@/lib/orders/returns/return-photo-client')>('@/lib/orders/returns/return-photo-client'),
  checkReturnPhotoFile: (...args: unknown[]) => mockCheck(...args),
  resizeReturnPhoto: (...args: unknown[]) => mockResize(...args),
  uploadReturnPhoto: (...args: unknown[]) => mockUpload(...args),
}));

import { ReturnPhotoPicker } from '@/features/account/returns/ReturnPhotoPicker';
import type { PickedPhoto } from '@/features/account/returns/return-request-model';
import { ORDER_ID } from './return-request-fixtures';

type HarnessProps = {
  initial?: PickedPhoto[];
  rule?: 'optional' | 'required';
  instructions?: string;
  errorText?: string;
};

/** 親の代わり: 写真の一覧を持ち、その中身（状態と送り先の番号）を画面に出す */
function Harness({ initial = [], rule = 'required', instructions = '', errorText }: HarnessProps) {
  const [photos, setPhotos] = React.useState<PickedPhoto[]>(initial);
  return (
    <>
      <ReturnPhotoPicker
        idPrefix="rr-test"
        orderId={ORDER_ID}
        rule={rule}
        instructions={instructions}
        photos={photos}
        onPhotosChange={setPhotos}
        errorText={errorText}
      />
      <output data-testid="state">{JSON.stringify(photos.map((photo) => [photo.status, photo.uploadId]))}</output>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '[]') as Array<[string, string | null]>;
const file = (name = 'a.jpg', type = 'image/jpeg') => new File(['x'], name, { type });
const choose = (files: File[]) => fireEvent.change(screen.getByTestId('return-photo-input'), { target: { files } });
const sentPhoto = (uploadId: string, previewUrl: string | null = null): PickedPhoto => ({
  id: `id-${uploadId}`, status: 'sent', uploadId, previewUrl,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const TYPE_MESSAGE = 'JPEG か PNG の写真を選んでください。';
const SIZE_MESSAGE = '1枚 10MB までの写真を選んでください。';
const LIMIT_MESSAGE = '写真は5枚までです。';
const FAILED_MESSAGE = '写真を送れませんでした。もう一度選んでください。';
const DATA_URL = /^data:image\/jpeg;base64,/;
/** ページの CSP の img-src は blob: を許さないので、見本に使ってはいけない。使われたら気づけるよう印を付けておく */
const mockCreateObjectUrl = jest.fn(() => 'blob:never-used');

beforeEach(() => {
  mockCheck.mockReset().mockReturnValue('ok');
  mockResize.mockReset().mockResolvedValue(new Blob(['resized'], { type: 'image/jpeg' }));
  mockUpload.mockReset().mockResolvedValue({ kind: 'ok', uploadId: 'up-1' });
  mockCreateObjectUrl.mockClear();
  URL.createObjectURL = mockCreateObjectUrl;
});

describe('ReturnPhotoPicker の見た目', () => {
  it('必須なら「写真（必須・5枚まで）」、任意なら「写真（任意・5枚まで）」の見出しで、案内の文は書かれたとおりに出す', () => {
    const { unmount } = render(<Harness rule="required" instructions={'破損している所が分かる写真を撮ってください。\n全体と近くの2枚をお願いします。'} />);

    const group = screen.getByRole('group', { name: '写真（必須・5枚まで）' });
    expect(within(group).getByText(/破損している所が分かる写真/)).toHaveClass('whitespace-pre-wrap', 'break-words');
    expect(within(group).getByText(/全体と近くの2枚/)).toBeInTheDocument();
    unmount();

    render(<Harness rule="optional" />);
    expect(screen.getByRole('group', { name: '写真（任意・5枚まで）' })).toBeInTheDocument();
  });

  it('入力は JPEG・PNG だけを受ける複数選びで、画面には出さず「写真を選ぶ」から開く', () => {
    render(<Harness />);

    const input = screen.getByTestId('return-photo-input');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png');
    expect(input).toHaveAttribute('multiple');
    expect(input).toHaveAttribute('hidden');

    const click = jest.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(screen.getByRole('button', { name: '写真を選ぶ' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('親の誤り（写真が必須なのに無い）を出す', () => {
    render(<Harness errorText="写真を1枚以上選んでください。" />);

    expect(screen.getByText('写真を1枚以上選んでください。')).toBeInTheDocument();
  });
});

describe('ReturnPhotoPicker の選ぶ・縮める・送る', () => {
  it('選んだ写真を縮めて、注文の番号つきで送る。送っている間は「送っています」を出し、外すボタンは出さない。終わったら送り先の番号を持つ', async () => {
    const upload = deferred<{ kind: 'ok'; uploadId: string }>();
    mockUpload.mockReturnValueOnce(upload.promise);
    render(<Harness />);
    const picked = file('shirt.jpg');

    choose([picked]);

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockResize).toHaveBeenCalledWith(picked);
    const resized = await mockResize.mock.results[0].value;
    expect(mockUpload).toHaveBeenCalledWith(ORDER_ID, resized);
    expect(state()).toEqual([['sending', null]]);
    expect(screen.getByText('写真を送っています…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'この写真を外す' })).not.toBeInTheDocument();

    upload.resolve({ kind: 'ok', uploadId: 'up-7' });

    await waitFor(() => expect(state()).toEqual([['sent', 'up-7']]));
    expect(screen.queryByText('写真を送っています…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'この写真を外す' })).toBeInTheDocument();
    // 縮小画像の見本は data: のアドレスで一覧に出す（blob: は CSP が許さない）
    await waitFor(() => expect(document.querySelector('img')?.getAttribute('src') ?? '').toMatch(DATA_URL));
    expect(mockCreateObjectUrl).not.toHaveBeenCalled();
  });

  it('複数の写真を一度に選ぶと、それぞれを送り、選んだ順に並べる', async () => {
    mockUpload.mockReset().mockResolvedValueOnce({ kind: 'ok', uploadId: 'up-1' }).mockResolvedValueOnce({ kind: 'ok', uploadId: 'up-2' });
    render(<Harness />);

    choose([file('a.jpg'), file('b.png', 'image/png')]);

    await waitFor(() => expect(state()).toEqual([['sent', 'up-1'], ['sent', 'up-2']]));
    expect(screen.getAllByRole('button', { name: 'この写真を外す' })).toHaveLength(2);
  });

  it('JPEG・PNG でない写真は、文を出して送らない', async () => {
    mockCheck.mockReturnValue('type');
    render(<Harness />);

    choose([file('movie.gif', 'image/gif')]);

    expect(await screen.findByText(TYPE_MESSAGE)).toBeInTheDocument();
    expect(mockResize).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(state()).toEqual([]);
  });

  it('10MB を超える写真は、文を出して送らない', async () => {
    mockCheck.mockReturnValue('size');
    render(<Harness />);

    choose([file('big.jpg')]);

    expect(await screen.findByText(SIZE_MESSAGE)).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(state()).toEqual([]);
  });

  it('選べない写真と選べる写真を一緒に選んだら、選べる写真だけ送り、最初の問題の文を出す', async () => {
    mockCheck.mockReturnValueOnce('size').mockReturnValueOnce('ok').mockReturnValueOnce('type');
    render(<Harness />);

    choose([file('big.jpg'), file('good.jpg'), file('movie.gif', 'image/gif')]);

    await waitFor(() => expect(state()).toEqual([['sent', 'up-1']]));
    expect(screen.getByText(SIZE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(TYPE_MESSAGE)).not.toBeInTheDocument();
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it('5枚までしか付けられない: 5枚付いた後は「写真を選ぶ」が押せず、選んでも送らずに文を出す', async () => {
    render(<Harness initial={['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => sentPhoto(id))} />);

    expect(screen.getByRole('button', { name: '写真を選ぶ' })).toBeDisabled();
    choose([file()]);

    expect(await screen.findByText(LIMIT_MESSAGE)).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
    expect(state()).toHaveLength(5);
  });

  it('あと2枚の余地に3枚選んだら、先の2枚だけ送り、枚数の文を出す', async () => {
    mockUpload.mockReset().mockResolvedValueOnce({ kind: 'ok', uploadId: 'up-4' }).mockResolvedValueOnce({ kind: 'ok', uploadId: 'up-5' });
    render(<Harness initial={['u1', 'u2', 'u3'].map((id) => sentPhoto(id))} />);

    choose([file('a.jpg'), file('b.jpg'), file('c.jpg')]);

    await waitFor(() => expect(state().map((entry) => entry[1])).toEqual(['u1', 'u2', 'u3', 'up-4', 'up-5']));
    expect(screen.getByText(LIMIT_MESSAGE)).toBeInTheDocument();
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '写真を選ぶ' })).toBeDisabled();
  });

  it('送れなかった時は、その写真を一覧から外し、送る道具の文を出す（見本が後から出来上がっても、一覧には戻らない）', async () => {
    mockUpload.mockResolvedValueOnce({ kind: 'error', message: FAILED_MESSAGE });
    render(<Harness />);

    choose([file()]);

    expect(await screen.findByText(FAILED_MESSAGE)).toBeInTheDocument();
    expect(state()).toEqual([]);
    // 見本の読み込みが終わるのを待っても、外した写真は戻らない
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(state()).toEqual([]);
    expect(document.querySelector('img')).toBeNull();
  });

  it('縮められなかった時と、送る道具が例外を投げた時は、「写真を送れませんでした。もう一度選んでください。」を出して一覧に残さない', async () => {
    mockResize.mockRejectedValueOnce(new Error('decode failed'));
    mockUpload.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Harness />);

    choose([file('broken.jpg')]);
    expect(await screen.findByText(FAILED_MESSAGE)).toBeInTheDocument();
    expect(state()).toEqual([]);
    expect(mockUpload).not.toHaveBeenCalled();

    choose([file('ok.jpg')]);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(state()).toEqual([]));
    expect(screen.getByText(FAILED_MESSAGE)).toBeInTheDocument();
  });

  it('次に選び直すと、前の文は新しい結果に入れ替わる', async () => {
    mockCheck.mockReturnValueOnce('type').mockReturnValueOnce('ok');
    render(<Harness />);

    choose([file('movie.gif', 'image/gif')]);
    expect(await screen.findByText(TYPE_MESSAGE)).toBeInTheDocument();

    choose([file('good.jpg')]);

    await waitFor(() => expect(state()).toEqual([['sent', 'up-1']]));
    expect(screen.queryByText(TYPE_MESSAGE)).not.toBeInTheDocument();
  });

  it('親の誤りより、選んだ時の文を先に出す', async () => {
    mockCheck.mockReturnValue('type');
    render(<Harness errorText="写真を1枚以上選んでください。" />);

    choose([file('movie.gif', 'image/gif')]);

    expect(await screen.findByText(TYPE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('写真を1枚以上選んでください。')).not.toBeInTheDocument();
  });
});

describe('ReturnPhotoPicker の外す', () => {
  it('「この写真を外す」で、その写真だけを外す（見本も一緒に消える）', () => {
    render(<Harness initial={[sentPhoto('up-1', 'data:image/jpeg;base64,AAAA'), sentPhoto('up-2', 'data:image/jpeg;base64,BBBB')]} />);
    expect(document.querySelectorAll('img')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'この写真を外す' })[0]);

    expect(state()).toEqual([['sent', 'up-2']]);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,BBBB');
  });

  it('外すと、5枚に達して押せなかった「写真を選ぶ」がまた押せる', () => {
    render(<Harness initial={['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => sentPhoto(id))} />);
    expect(screen.getByRole('button', { name: '写真を選ぶ' })).toBeDisabled();

    fireEvent.click(screen.getAllByRole('button', { name: 'この写真を外す' })[0]);

    expect(screen.getByRole('button', { name: '写真を選ぶ' })).toBeEnabled();
  });
});
