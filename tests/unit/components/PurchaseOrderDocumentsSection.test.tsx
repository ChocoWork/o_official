import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderDocumentsSection from '@/components/PurchaseOrderDocumentsSection';
import { clientFetch } from '@/lib/client-fetch';
import { resumePurchaseOrderDocument, uploadPurchaseOrderDocument } from '@/lib/purchase-orders/purchase-order-documents-client';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders/purchase-order-types';
import { ATTACHMENT_ID, confirmedDetail, ORDER_ID, RESERVATION_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
jest.mock('@/lib/purchase-orders/purchase-order-documents-client', () => ({
  ...jest.requireActual('@/lib/purchase-orders/purchase-order-documents-client'),
  uploadPurchaseOrderDocument: jest.fn(),
  resumePurchaseOrderDocument: jest.fn(),
}));
const fetchMock = jest.mocked(clientFetch);
const uploadMock = jest.mocked(uploadPurchaseOrderDocument);
const resumeMock = jest.mocked(resumePurchaseOrderDocument);

const SIGNED_VIEW = 'https://storage.example.test/object/sign/purchase-order-documents/SECRET-VIEW-TOKEN';
const VOIDED_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const URL_ENDPOINT = (id: string, download = false) => `/api/admin/purchase-orders/${ORDER_ID}/attachments/${id}/url${download ? '?download=1' : ''}`;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 請求書 invoice.pdf（有効）と、無効になった見積書 old.pdf、保存が終わっていない予約（期限切れ）を持つ発注書 */
function detail(): PurchaseOrderDetail {
  const base = confirmedDetail();
  const [attachment] = base.attachments;
  return {
    ...base,
    attachments: [
      attachment,
      {
        ...attachment, id: VOIDED_ID, kind: 'quote', fileName: 'old.pdf',
        current: { ...attachment.current, revisionNo: 2, voided: true, reason: '宛先の誤り', counterparty: '工場B', amountYen: 3000 }, revisionCount: 2,
      },
    ],
  };
}

const onSaved = jest.fn();
const onReload = jest.fn();

function renderSection(purchaseOrder: PurchaseOrderDetail = detail()) {
  return render(<PurchaseOrderDocumentsSection purchaseOrder={purchaseOrder} onSaved={onSaved} onReload={onReload} />);
}

/** window.open が返す空のタブの代わり（クリックの中で開き、リンクが取れたら location.href を替え、取れなければ close する） */
function mockNewTab() {
  const tab = { close: jest.fn(), opener: {} as unknown, location: { href: '' } };
  const open = jest.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  return { open, tab };
}

const documentOf = (fileName: string) => screen.getAllByTestId('purchase-order-document').find((item) => item.textContent?.includes(fileName))!;
const pdf = () => new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderDocumentsSection: 一覧', () => {
  test('FREQ-530-AC-02: h2「取引書類」と「書類を追加」を出し、書類ごとに 種類・ファイル名・取引日・金額・取引先を出す（確定前のファイルは出さない）', () => {
    renderSection();
    const section = screen.getByRole('region', { name: '取引書類' });
    expect(within(section).getByRole('heading', { level: 2, name: '取引書類' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: '書類を追加' })).toBeInTheDocument();
    const items = within(section).getAllByTestId('purchase-order-document');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('請求書');
    expect(items[0]).toHaveTextContent('invoice.pdf');
    expect(items[0]).toHaveTextContent('取引日 2026/10/26');
    expect(items[0]).toHaveTextContent('金額（円） ¥6,000');
    expect(items[0]).toHaveTextContent('取引先 工場A');
    // 保存が終わっていない quote.pdf は添付の一覧に混ぜない
    for (const item of items) expect(item).not.toHaveTextContent('quote.pdf');
  });

  test('FREQ-530-AC-02: 無効な書類にだけ「無効」のバッジと理由を出す。有効な書類にバッジは無い', () => {
    renderSection();
    expect(within(documentOf('old.pdf')).getByText('無効')).toBeInTheDocument();
    expect(documentOf('old.pdf')).toHaveTextContent('理由 宛先の誤り');
    expect(within(documentOf('invoice.pdf')).queryByText('無効')).not.toBeInTheDocument();
  });

  test('FREQ-530-AC-02: 各書類に 表示・ダウンロード・印刷・情報を訂正・差し替える・無効にする のボタン。無効な書類は「無効にする」が無い。操作は書類名の group で区別できる', () => {
    renderSection();
    const valid = within(screen.getByRole('group', { name: 'invoice.pdf の操作' }));
    expect(valid.getAllByRole('button').map((button) => button.textContent)).toEqual(['表示', 'ダウンロード', '印刷', '情報を訂正', '差し替える', '無効にする']);
    const voided = within(screen.getByRole('group', { name: 'old.pdf の操作' }));
    expect(voided.getAllByRole('button').map((button) => button.textContent)).toEqual(['表示', 'ダウンロード', '印刷', '情報を訂正', '差し替える']);
  });

  test('FREQ-530-AC-02: 書類が無ければ「取引書類はまだありません。」', () => {
    renderSection({ ...detail(), attachments: [], pendingUploads: [] });
    expect(screen.getByText('取引書類はまだありません。')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '保存が終わっていないファイル' })).not.toBeInTheDocument();
  });

  test('FREQ-530-AC-03: 保存が終わっていないファイルは見出し「保存が終わっていないファイル」に、種類・ファイル名・日付と「続きから保存」を並べる。期限を過ぎた予約には確認の文を出し、消す操作は無い', () => {
    renderSection();
    const heading = screen.getByRole('heading', { level: 3, name: '保存が終わっていないファイル' });
    expect(heading).toBeInTheDocument();
    const pending = screen.getByTestId('purchase-order-pending-upload');
    expect(pending).toHaveTextContent('見積書');
    expect(pending).toHaveTextContent('quote.pdf');
    // 2026-10-25T15:00Z は日本時間の 2026/10/26 00:00
    expect(pending).toHaveTextContent('2026/10/26');
    expect(pending).toHaveTextContent('期限を過ぎています。内容を確認してください。');
    expect(within(pending).getAllByRole('button').map((button) => button.textContent)).toEqual(['続きから保存']);
  });

  test('FREQ-530-AC-03: 期限内の予約には期限切れの文を出さない', () => {
    const base = detail();
    renderSection({ ...base, pendingUploads: [{ ...base.pendingUploads[0], expired: false }] });
    expect(screen.getByTestId('purchase-order-pending-upload')).not.toHaveTextContent('期限を過ぎています');
    expect(screen.getByRole('button', { name: '続きから保存' })).toBeInTheDocument();
  });
});

describe('PurchaseOrderDocumentsSection: 表示・ダウンロード・印刷', () => {
  test('FREQ-530-AC-03: 「表示」は表示用の署名つきリンクをもらって新しいタブで開く。リンクは画面に出さない', async () => {
    const user = userEvent.setup();
    const { open, tab } = mockNewTab();
    fetchMock.mockResolvedValueOnce(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '表示' }));
    await waitFor(() => expect(tab.location.href).toBe(SIGNED_VIEW));
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_ENDPOINT(ATTACHMENT_ID), { cache: 'no-store' });
    // 空のタブを先に開き、opener を切ってから、リンクが取れたタブを移す（リンクは window.open の引数に渡さない）
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('SECRET-VIEW-TOKEN');
  });

  test('FREQ-530-AC-03: 「印刷」も表示用のリンクを新しいタブで開く（印刷はそのタブのブラウザの印刷で行う）', async () => {
    const user = userEvent.setup();
    const { open, tab } = mockNewTab();
    fetchMock.mockResolvedValueOnce(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'old.pdf の操作' })).getByRole('button', { name: '印刷' }));
    await waitFor(() => expect(tab.location.href).toBe(SIGNED_VIEW));
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(fetchMock).toHaveBeenCalledWith(URL_ENDPOINT(VOIDED_ID), { cache: 'no-store' });
  });

  test('FREQ-530-AC-03: 新しいタブはリンクを待つ前に（クリックの中で）開く。リンクが取れるまでタブは空のまま', async () => {
    const user = userEvent.setup();
    const { open, tab } = mockNewTab();
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '表示' }));
    // 窓口の応答はまだ無い。その時点で空のタブは開いていて、まだ移していない
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');
    release(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
    await waitFor(() => expect(tab.location.href).toBe(SIGNED_VIEW));
  });

  test.each(['表示', '印刷'])('FREQ-530-AC-03: ブラウザが新しいタブを止めた時（%s）は、role=alert で止められたことを知らせ、リンクは取りに行かない', async (name) => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name }));
    expect(await screen.findByRole('alert')).toHaveTextContent('新しいタブがブラウザに止められました。このサイトのポップアップを許可して、もう一度押してください。');
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 「ダウンロード」は download=1 のリンクをもらい、保存として開く（ページは移らない）', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      expect(this.href).toBe(SIGNED_VIEW);
      expect(this.rel).toBe('noopener');
    });
    fetchMock.mockResolvedValueOnce(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: 'ダウンロード' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(URL_ENDPOINT(ATTACHMENT_ID, true), { cache: 'no-store' });
    expect(open).not.toHaveBeenCalled();
  });

  test.each([
    ['置き場に無い（404）', 404, { code: 'DOCUMENT_NOT_FOUND', error: 'x' }, '原本を取得できません。'],
    ['置き場の不調（503）', 503, { code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'x' }, 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
    ['権限が無い（403）', 403, { code: 'GROUP_G_FORBIDDEN', error: 'x' }, '発注を扱う権限がありません。'],
    ['2要素認証が無い', 403, { error: 'Forbidden', reason: 'MFA required' }, '2要素認証が必要です'],
    ['ログインが切れた（401）', 401, { error: 'Unauthorized' }, 'ログインし直してください。'],
    ['想定外の失敗（500）', 500, { error: 'x' }, '発注の記録に失敗しました'],
  ])('FREQ-530-AC-03: リンクをもらえない（%s）時は role=alert で文を出し、先に開いた空のタブを閉じて、原本へは移さない', async (_name, status, body, message) => {
    const user = userEvent.setup();
    const { tab } = mockNewTab();
    fetchMock.mockResolvedValueOnce(json(body, status));
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '表示' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
  });

  test('FREQ-530-AC-03: リンクの応答が崩れている・通信が失敗した時は「原本を取得できません。」で、空のタブを閉じる', async () => {
    const user = userEvent.setup();
    const { tab } = mockNewTab();
    fetchMock.mockResolvedValueOnce(json({}));
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '表示' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('原本を取得できません。');
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '表示' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent('原本を取得できません。');
    await waitFor(() => expect(tab.close).toHaveBeenCalledTimes(2));
    expect(tab.location.href).toBe('');
  });
});

describe('PurchaseOrderDocumentsSection: 書類を追加・差し替える', () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '書類を追加' }));
    return screen.getByRole('dialog', { name: '書類を追加' });
  }

  async function fill(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, values: { date?: string; amount?: string; counterparty?: string; file?: File | null } = {}) {
    if (values.date !== undefined) fireEvent.change(within(dialog).getByLabelText('取引日'), { target: { value: values.date } });
    if (values.amount) await user.type(within(dialog).getByLabelText('金額（円）'), values.amount);
    if (values.counterparty) await user.type(within(dialog).getByLabelText('取引先'), values.counterparty);
    if (values.file) await user.upload(within(dialog).getByLabelText('ファイル'), values.file);
  }

  test('FREQ-530-AC-02: 追加の入力欄は 種類（見積書・請求書）・取引日・金額（円）・取引先・ファイル。ファイルは PDF・JPEG・PNG', async () => {
    const user = userEvent.setup();
    renderSection();
    const dialog = await openAdd(user);
    const kind = within(dialog).getByLabelText('種類') as HTMLSelectElement;
    expect(within(kind).getAllByRole('option').map((option) => option.textContent)).toEqual(['見積書', '請求書']);
    for (const label of ['取引日', '金額（円）', '取引先']) expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('ファイル')).toHaveAttribute('accept', 'application/pdf,image/jpeg,image/png');
    expect(within(dialog).getByRole('button', { name: '保存する' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeInTheDocument();
  });

  test.each([
    ['取引日が空', { date: '', amount: '6000', counterparty: '工場A' }],
    ['取引日が 2000-01-01 より前', { date: '1999-12-31', amount: '6000', counterparty: '工場A' }],
    ['金額が数字でない', { date: '2026-10-26', amount: '6,000', counterparty: '工場A' }],
    ['金額が空', { date: '2026-10-26', amount: '', counterparty: '工場A' }],
    ['金額が12桁', { date: '2026-10-26', amount: '100000000000', counterparty: '工場A' }],
    ['取引先が空白だけ', { date: '2026-10-26', amount: '6000', counterparty: '   ' }],
  ])('FREQ-530-AC-02: %s なら送らず「取引日・金額・取引先を入力してください。」', async (_name, values) => {
    const user = userEvent.setup();
    renderSection();
    const dialog = await openAdd(user);
    await fill(user, dialog, { ...values, file: pdf() });
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('取引日・金額・取引先を入力してください。');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-02: ファイルが無ければ送らず「ファイルを選んでください。」', async () => {
    const user = userEvent.setup();
    renderSection();
    const dialog = await openAdd(user);
    await fill(user, dialog, { date: '2026-10-26', amount: '6000', counterparty: '工場A' });
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('ファイルを選んでください。');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-02: 保存すると種類・取引日・金額・取引先（空白を落とす）・ファイルで送り、成功したら「書類を保存しました。」で親に知らせる', async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    renderSection();
    const dialog = await openAdd(user);
    await user.selectOptions(within(dialog).getByLabelText('種類'), '見積書');
    const file = pdf();
    await fill(user, dialog, { date: '2026-10-26', amount: '6000', counterparty: ' 工場A ', file });
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を保存しました。'));
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledWith({
      purchaseOrderId: ORDER_ID, file, kind: 'quote', meta: { transactionDate: '2026-10-26', amountYen: 6000, counterparty: '工場A', replacesAttachmentId: null },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('FREQ-530-AC-02: 送信中は二重に送らず、閉じない', async () => {
    const user = userEvent.setup();
    let release: (value: Awaited<ReturnType<typeof uploadPurchaseOrderDocument>>) => void = () => undefined;
    uploadMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderSection();
    const dialog = await openAdd(user);
    await fill(user, dialog, { date: '2026-10-26', amount: '6000', counterparty: '工場A', file: pdf() });
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(within(dialog).getByRole('button', { name: '保存する' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.submit(within(dialog).getByRole('button', { name: '保存する' }).closest('form')!);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    await act(async () => { release({ kind: 'ok', attachmentId: ATTACHMENT_ID }); });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test('FREQ-530-AC-02: 送れなかった（error）時は文を role=alert で出し、ダイアログは開いたまま入力を保つ', async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue({ kind: 'error', message: 'ファイルは 20 MiB までです。' });
    renderSection();
    const dialog = await openAdd(user);
    await fill(user, dialog, { date: '2026-10-26', amount: '6000', counterparty: '工場A', file: pdf() });
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ファイルは 20 MiB までです。');
    expect(within(dialog).getByLabelText('取引先')).toHaveValue('工場A');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-03: 置き場へ送れなかった（pending）時は、ダイアログを閉じて発注書を読み直させ、保存が終わっていない旨を role=alert で出す', async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue({ kind: 'pending', reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' });
    renderSection();
    const dialog = await openAdd(user);
    await fill(user, dialog, { date: '2026-10-26', amount: '6000', counterparty: '工場A', file: pdf() });
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('書類の保存が終わっていません。');
    expect(screen.getByRole('alert')).toHaveTextContent('ファイルを送れませんでした。続きから保存してください。');
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('FREQ-530-AC-02: 「差し替える」は元の書類の種類・取引日・金額・取引先を初期値にして、元の書類の id を差し替え元として送る', async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '差し替える' }));
    const dialog = screen.getByRole('dialog', { name: '書類を差し替える' });
    expect(within(dialog).getByLabelText('種類')).toHaveValue('invoice');
    expect(within(dialog).getByLabelText('取引日')).toHaveValue('2026-10-26');
    expect(within(dialog).getByLabelText('金額（円）')).toHaveValue('6000');
    expect(within(dialog).getByLabelText('取引先')).toHaveValue('工場A');
    const file = new File(['%PDF'], 'new.pdf', { type: 'application/pdf' });
    await user.upload(within(dialog).getByLabelText('ファイル'), file);
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledWith({
      purchaseOrderId: ORDER_ID, file, kind: 'invoice', meta: { transactionDate: '2026-10-26', amountYen: 6000, counterparty: '工場A', replacesAttachmentId: ATTACHMENT_ID },
    });
  });

  test('FREQ-530-AC-02: 「戻る」でダイアログを閉じる。何も送らない', async () => {
    const user = userEvent.setup();
    renderSection();
    const dialog = await openAdd(user);
    await user.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrderDocumentsSection: 続きから保存', () => {
  async function openResume(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: '続きから保存' }));
    return screen.getByRole('dialog', { name: '続きから保存' });
  }

  async function fillMeta(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
    fireEvent.change(within(dialog).getByLabelText('取引日'), { target: { value: '2026-10-27' } });
    await user.type(within(dialog).getByLabelText('金額（円）'), '4500');
    await user.type(within(dialog).getByLabelText('取引先'), '工場C');
  }

  test('FREQ-530-AC-03: 取引日・金額・取引先を入れ直す欄を出す（種類は予約のまま。ファイルの欄は、置き場に無いと分かるまで出さない）', async () => {
    const user = userEvent.setup();
    renderSection();
    const dialog = await openResume(user);
    expect(dialog).toHaveTextContent('見積書 quote.pdf');
    for (const label of ['取引日', '金額（円）', '取引先']) expect(within(dialog).getByLabelText(label)).toHaveValue('');
    expect(within(dialog).queryByLabelText('種類')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('ファイル')).not.toBeInTheDocument();
  });

  test('FREQ-530-AC-03: ページを読み直した後の再開: ファイル無しで送り、置き場に保存済みなら確定して「書類を保存しました。」', async () => {
    const user = userEvent.setup();
    resumeMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    renderSection();
    const dialog = await openResume(user);
    await fillMeta(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を保存しました。'));
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith({
      purchaseOrderId: ORDER_ID, reservationId: RESERVATION_ID, reservationFileName: 'quote.pdf', file: null,
      meta: { transactionDate: '2026-10-27', amountYen: 4500, counterparty: '工場C' },
    });
  });

  test('FREQ-530-AC-03: 置き場に無ければ（needs_file）ファイルの選び直しを求め、選んだファイルで送り直す', async () => {
    const user = userEvent.setup();
    resumeMock.mockResolvedValueOnce({ kind: 'needs_file', reservationId: RESERVATION_ID });
    renderSection();
    const dialog = await openResume(user);
    await fillMeta(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('ファイルを選び直してください。');
    const picker = within(dialog).getByLabelText('ファイル');
    expect(picker).toHaveAttribute('accept', 'application/pdf,image/jpeg,image/png');
    expect(onSaved).not.toHaveBeenCalled();

    resumeMock.mockResolvedValueOnce({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    const file = pdf();
    await user.upload(picker, file);
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を保存しました。'));
    expect(resumeMock).toHaveBeenLastCalledWith(expect.objectContaining({ reservationId: RESERVATION_ID, file }));
  });

  test('FREQ-530-AC-03: 選び直しを求められた後でファイルを選ばずに送ると「ファイルを選んでください。」', async () => {
    const user = userEvent.setup();
    resumeMock.mockResolvedValueOnce({ kind: 'needs_file', reservationId: RESERVATION_ID });
    renderSection();
    const dialog = await openResume(user);
    await fillMeta(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await within(dialog).findByLabelText('ファイル');
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('ファイルを選んでください。');
    expect(resumeMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['error', { kind: 'error' as const, message: 'この書類はすでに登録されています。' }],
    ['pending', { kind: 'pending' as const, reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' }],
  ])('FREQ-530-AC-03: 再開が失敗（%s）したら文を role=alert で出し、ダイアログは開いたまま', async (_name, result) => {
    const user = userEvent.setup();
    resumeMock.mockResolvedValue(result);
    renderSection();
    const dialog = await openResume(user);
    await fillMeta(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(result.message);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '続きから保存' })).toBeInTheDocument();
    // すでに登録済みなどで一覧が変わりうるので、発注書を読み直す
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test('FREQ-530-AC-03: この画面で送れなかったファイルは覚えていて、続きから保存では入力とファイルを引き継ぐ（ファイルを選び直さない）', async () => {
    const user = userEvent.setup();
    const file = pdf();
    uploadMock.mockResolvedValue({ kind: 'pending', reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' });
    const view = renderSection({ ...detail(), pendingUploads: [] });
    await user.click(screen.getByRole('button', { name: '書類を追加' }));
    const addDialog = screen.getByRole('dialog', { name: '書類を追加' });
    fireEvent.change(within(addDialog).getByLabelText('取引日'), { target: { value: '2026-10-26' } });
    await user.type(within(addDialog).getByLabelText('金額（円）'), '6000');
    await user.type(within(addDialog).getByLabelText('取引先'), '工場A');
    await user.upload(within(addDialog).getByLabelText('ファイル'), file);
    await user.click(within(addDialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));

    // 読み直した発注書に予約が出る
    view.rerender(<PurchaseOrderDocumentsSection purchaseOrder={detail()} onSaved={onSaved} onReload={onReload} />);
    resumeMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
    const dialog = await openResume(user);
    expect(within(dialog).getByLabelText('取引日')).toHaveValue('2026-10-26');
    expect(within(dialog).getByLabelText('金額（円）')).toHaveValue('6000');
    expect(within(dialog).getByLabelText('取引先')).toHaveValue('工場A');
    expect(within(dialog).queryByLabelText('ファイル')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(1));
    expect(resumeMock).toHaveBeenCalledWith({
      purchaseOrderId: ORDER_ID, reservationId: RESERVATION_ID, reservationFileName: 'quote.pdf', file,
      meta: { transactionDate: '2026-10-26', amountYen: 6000, counterparty: '工場A' },
    });
  });

  describe('差し替えの関係は予約に残る（頁を読み直しても保たれる）', () => {
    const replacing = (replacesAttachmentId: string | null): PurchaseOrderDetail => {
      const base = detail();
      return { ...base, pendingUploads: [{ ...base.pendingUploads[0], replacesAttachmentId }] };
    };

    test('FREQ-530-AC-03: 差し替えの予約が止まった後の続きから保存（この画面で覚えたファイルで）は、差し替え元を本文に足さず、予約の関係のまま確定する', async () => {
      const user = userEvent.setup();
      const file = new File(['%PDF'], 'quote.pdf', { type: 'application/pdf' });
      uploadMock.mockResolvedValue({ kind: 'pending', reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' });
      const view = renderSection({ ...detail(), pendingUploads: [] });
      await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '差し替える' }));
      const replaceDialog = screen.getByRole('dialog', { name: '書類を差し替える' });
      await user.upload(within(replaceDialog).getByLabelText('ファイル'), file);
      await user.click(within(replaceDialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
      // 予約を作る時に、差し替え元を送っている
      expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ replacesAttachmentId: ATTACHMENT_ID }) }));

      // 読み直した発注書の予約が差し替え元を持っている
      view.rerender(<PurchaseOrderDocumentsSection purchaseOrder={replacing(ATTACHMENT_ID)} onSaved={onSaved} onReload={onReload} />);
      resumeMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
      await user.click(screen.getByRole('button', { name: '続きから保存' }));
      await user.click(within(screen.getByRole('dialog', { name: '続きから保存' })).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(resumeMock).toHaveBeenCalledTimes(1));
      expect(resumeMock).toHaveBeenCalledWith(expect.objectContaining({ reservationId: RESERVATION_ID, file }));
      expect(Object.keys(resumeMock.mock.calls[0][0].meta)).not.toContain('replacesAttachmentId');
      expect(JSON.stringify(resumeMock.mock.calls[0][0])).not.toContain(ATTACHMENT_ID);
    });

    test('FREQ-530-AC-03: 頁を読み直した後の続きから保存（ファイルは手元に無い）でも、差し替え元を本文に足さない。予約の関係は DB が写す', async () => {
      const user = userEvent.setup();
      resumeMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
      renderSection(replacing(ATTACHMENT_ID));
      await user.click(screen.getByRole('button', { name: '続きから保存' }));
      const dialog = screen.getByRole('dialog', { name: '続きから保存' });
      fireEvent.change(within(dialog).getByLabelText('取引日'), { target: { value: '2026-10-27' } });
      await user.type(within(dialog).getByLabelText('金額（円）'), '4500');
      await user.type(within(dialog).getByLabelText('取引先'), '工場C');
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を保存しました。'));
      expect(resumeMock).toHaveBeenCalledWith({
        purchaseOrderId: ORDER_ID, reservationId: RESERVATION_ID, reservationFileName: 'quote.pdf', file: null,
        meta: { transactionDate: '2026-10-27', amountYen: 4500, counterparty: '工場C' },
      });
      expect(uploadMock).not.toHaveBeenCalled();
    });
  });

  describe('種類の検査に通らないファイル（rejected）は行き止まりにしない', () => {
    const REJECTED = 'このファイルは保存できませんでした。PDF・JPEG・PNG の正しいファイルを選び直して、新しく保存してください。';
    const replacing = (replacesAttachmentId: string | null): PurchaseOrderDetail => {
      const base = detail();
      return { ...base, pendingUploads: [{ ...base.pendingUploads[0], replacesAttachmentId }] };
    };

    test('FREQ-530-AC-03: 続きから保存で rejected なら、文を role=alert で出し、ファイルの欄を出して選び直させ、発注書を読み直す。同じ予約をもう一度試させない', async () => {
      const user = userEvent.setup();
      resumeMock.mockResolvedValue({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
      renderSection();
      const dialog = await openResume(user);
      expect(within(dialog).queryByLabelText('ファイル')).not.toBeInTheDocument();
      await fillMeta(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(REJECTED);
      expect(within(dialog).getByLabelText('ファイル')).toBeInTheDocument();
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();

      // ファイルを選ばずに送ると、予約へは進まず「ファイルを選んでください。」
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('ファイルを選んでください。');
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(uploadMock).not.toHaveBeenCalled();
    });

    test('FREQ-530-AC-03: rejected の後に選び直したファイルは、新しい予約（uploadPurchaseOrderDocument）で保存する。種類は止まった予約のまま・差し替え元は止まった予約が持つ物を引き継ぐ', async () => {
      const user = userEvent.setup();
      resumeMock.mockResolvedValue({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
      uploadMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
      renderSection(replacing(ATTACHMENT_ID));
      const dialog = await openResume(user);
      await fillMeta(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await within(dialog).findByLabelText('ファイル');

      const good = new File(['%PDF'], 'good.pdf', { type: 'application/pdf' });
      await user.upload(within(dialog).getByLabelText('ファイル'), good);
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を保存しました。'));
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(uploadMock).toHaveBeenCalledTimes(1);
      expect(uploadMock).toHaveBeenCalledWith({
        purchaseOrderId: ORDER_ID, file: good, kind: 'quote',
        meta: { transactionDate: '2026-10-27', amountYen: 4500, counterparty: '工場C', replacesAttachmentId: ATTACHMENT_ID },
      });
    });

    test('FREQ-530-AC-03: 差し替えでない予約が rejected になった後の保存し直しは replacesAttachmentId: null', async () => {
      const user = userEvent.setup();
      resumeMock.mockResolvedValue({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
      uploadMock.mockResolvedValue({ kind: 'ok', attachmentId: ATTACHMENT_ID });
      renderSection();
      const dialog = await openResume(user);
      await fillMeta(user, dialog);
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await within(dialog).findByLabelText('ファイル');
      await user.upload(within(dialog).getByLabelText('ファイル'), new File(['%PDF'], 'good.pdf', { type: 'application/pdf' }));
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
      expect(uploadMock.mock.calls[0][0].meta.replacesAttachmentId).toBeNull();
    });

    test('FREQ-530-AC-03: この画面で覚えたファイルが rejected になった時は、そのファイルを捨てて選び直させる（同じ中身で送り直さない）', async () => {
      const user = userEvent.setup();
      const bad = new File(['not a pdf'], 'quote.pdf', { type: 'application/pdf' });
      uploadMock.mockResolvedValueOnce({ kind: 'pending', reservationId: RESERVATION_ID, message: 'ファイルを送れませんでした。続きから保存してください。' });
      const view = renderSection({ ...detail(), pendingUploads: [] });
      await user.click(screen.getByRole('button', { name: '書類を追加' }));
      const addDialog = screen.getByRole('dialog', { name: '書類を追加' });
      fireEvent.change(within(addDialog).getByLabelText('取引日'), { target: { value: '2026-10-26' } });
      await user.type(within(addDialog).getByLabelText('金額（円）'), '6000');
      await user.type(within(addDialog).getByLabelText('取引先'), '工場A');
      await user.upload(within(addDialog).getByLabelText('ファイル'), bad);
      await user.click(within(addDialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));

      view.rerender(<PurchaseOrderDocumentsSection purchaseOrder={detail()} onSaved={onSaved} onReload={onReload} />);
      resumeMock.mockResolvedValue({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
      const dialog = await openResume(user);
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(REJECTED);
      const picker = within(dialog).getByLabelText('ファイル') as HTMLInputElement;
      expect(picker.files).toHaveLength(0);
      // 入力欄の取引日・金額・取引先は残る
      expect(within(dialog).getByLabelText('金額（円）')).toHaveValue('6000');
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('ファイルを選んでください。');
      expect(resumeMock).toHaveBeenCalledTimes(1);
    });

    test('FREQ-530-AC-03: 追加・差し替えの確定が rejected で返ったら、選んだファイルを捨てて文を role=alert で出し、発注書を読み直す（予約は期限まで残り、続きから保存の行き止まりにしない）。ダイアログは開いたまま、新しいファイルで保存し直せる', async () => {
      const user = userEvent.setup();
      uploadMock.mockResolvedValueOnce({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
      renderSection();
      await user.click(screen.getByRole('button', { name: '書類を追加' }));
      const dialog = screen.getByRole('dialog', { name: '書類を追加' });
      fireEvent.change(within(dialog).getByLabelText('取引日'), { target: { value: '2026-10-26' } });
      await user.type(within(dialog).getByLabelText('金額（円）'), '6000');
      await user.type(within(dialog).getByLabelText('取引先'), '工場A');
      await user.upload(within(dialog).getByLabelText('ファイル'), new File(['x'], 'fake.pdf', { type: 'application/pdf' }));
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(REJECTED);
      expect((within(dialog).getByLabelText('ファイル') as HTMLInputElement).files).toHaveLength(0);
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('dialog', { name: '書類を追加' })).toBeInTheDocument();

      // ファイルを選ばずに保存すると送らない
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('ファイルを選んでください。');
      expect(uploadMock).toHaveBeenCalledTimes(1);

      uploadMock.mockResolvedValueOnce({ kind: 'ok', attachmentId: ATTACHMENT_ID });
      const good = pdf();
      await user.upload(within(dialog).getByLabelText('ファイル'), good);
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を保存しました。'));
      expect(uploadMock).toHaveBeenCalledTimes(2);
      expect(uploadMock.mock.calls[1][0].file).toBe(good);
    });

    test('FREQ-530-AC-03: 差し替えの確定が rejected になった後の保存し直しも、差し替え元を送る', async () => {
      const user = userEvent.setup();
      uploadMock.mockResolvedValueOnce({ kind: 'rejected', reservationId: RESERVATION_ID, message: REJECTED });
      renderSection();
      await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '差し替える' }));
      const dialog = screen.getByRole('dialog', { name: '書類を差し替える' });
      await user.upload(within(dialog).getByLabelText('ファイル'), new File(['x'], 'fake.pdf', { type: 'application/pdf' }));
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await within(dialog).findByRole('alert');
      uploadMock.mockResolvedValueOnce({ kind: 'ok', attachmentId: ATTACHMENT_ID });
      await user.upload(within(dialog).getByLabelText('ファイル'), pdf());
      await user.click(within(dialog).getByRole('button', { name: '保存する' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(uploadMock.mock.calls[1][0].meta.replacesAttachmentId).toBe(ATTACHMENT_ID);
    });
  });
});

describe('PurchaseOrderDocumentsSection: 情報を訂正・無効にする', () => {
  const REVISIONS = `/api/admin/purchase-orders/${ORDER_ID}/attachments/${ATTACHMENT_ID}/revisions`;
  const revised = () => json({ attachmentId: ATTACHMENT_ID, revisionNo: 2, replayed: false }, 201);

  async function openCorrect(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '情報を訂正' }));
    return screen.getByRole('dialog', { name: '書類の情報を訂正' });
  }

  test('FREQ-530-AC-02: 「情報を訂正」は取引日・金額・取引先を今の値で出し、理由が必須。送ると voided は今のまま（有効）で、成功したら「書類の情報を訂正しました。」', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(revised());
    renderSection();
    const dialog = await openCorrect(user);
    expect(within(dialog).getByLabelText('取引日')).toHaveValue('2026-10-26');
    expect(within(dialog).getByLabelText('金額（円）')).toHaveValue('6000');
    expect(within(dialog).getByLabelText('取引先')).toHaveValue('工場A');
    await user.clear(within(dialog).getByLabelText('金額（円）'));
    await user.type(within(dialog).getByLabelText('金額（円）'), '6600');
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('理由を入力してください。');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('理由'), '  税込に直す  ');
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類の情報を訂正しました。'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(REVISIONS);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      transactionDate: '2026-10-26', amountYen: 6600, counterparty: '工場A', currency: 'JPY', voided: false, reason: '税込に直す', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test('FREQ-530-AC-02: 無効な書類を訂正しても無効のまま（voided: true）', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(revised());
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'old.pdf の操作' })).getByRole('button', { name: '情報を訂正' }));
    const dialog = screen.getByRole('dialog', { name: '書類の情報を訂正' });
    await user.type(within(dialog).getByLabelText('理由'), '取引先の訂正');
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/admin/purchase-orders/${ORDER_ID}/attachments/${VOIDED_ID}/revisions`);
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toMatchObject({ voided: true, counterparty: '工場B', amountYen: 3000 });
  });

  test('FREQ-530-AC-02: 「無効にする」は理由だけを求め、今の情報のまま voided: true で送る。成功したら「書類を無効にしました。」', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(revised());
    renderSection();
    await user.click(within(screen.getByRole('group', { name: 'invoice.pdf の操作' })).getByRole('button', { name: '無効にする' }));
    const dialog = screen.getByRole('dialog', { name: '書類を無効にする' });
    expect(within(dialog).queryByLabelText('金額（円）')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '無効にする' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('理由を入力してください。');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('理由'), '二重に登録した');
    await user.click(within(dialog).getByRole('button', { name: '無効にする' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('書類を無効にしました。'));
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      transactionDate: '2026-10-26', amountYen: 6000, counterparty: '工場A', currency: 'JPY', voided: true, reason: '二重に登録した', requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  test('FREQ-530-AC-02: 断られた時は表の文を role=alert で出し、開いたまま。通信の失敗後の再押下は同じ要求番号で送る', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_ARGUMENT_INVALID', error: 'x' }, 400));
    renderSection();
    const dialog = await openCorrect(user);
    await user.type(within(dialog).getByLabelText('理由'), '直す');
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(onSaved).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 503)).mockResolvedValueOnce(revised());
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    await within(dialog).findByText('発注の記録に失敗しました');
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const keys = fetchMock.mock.calls.map(([, init]) => (JSON.parse(init?.body as string) as { requestKey: string }).requestKey);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test('FREQ-530-AC-02: 成功の応答の形が崩れていれば成功にしない', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(json({ replayed: false }, 201));
    renderSection();
    const dialog = await openCorrect(user);
    await user.type(within(dialog).getByLabelText('理由'), '直す');
    await user.click(within(dialog).getByRole('button', { name: '訂正する' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('発注の記録に失敗しました');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('PurchaseOrderDocumentsSection: 390 / 768 / 1280 の構造', () => {
  test.each([390, 768, 1280])('FREQ-530-AC-02: 幅 %ipx でも書類は縦の一覧で、操作は折り返し、長いファイル名は折って頁を横に広げない', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    renderSection();
    const section = screen.getByRole('region', { name: '取引書類' });
    expect(section.className).toMatch(/space-y-3/);
    const list = within(section).getAllByRole('list')[0];
    expect(list.className).toMatch(/space-y-4/);
    for (const item of screen.getAllByTestId('purchase-order-document')) {
      expect(item.className).not.toMatch(/overflow-x|w-\[|min-w-\[/);
      expect(within(item).getByRole('group').className).toMatch(/flex-wrap/);
      expect(within(item).getByText(/\.pdf$/).className).toMatch(/break-all/);
    }
    expect(screen.getByTestId('purchase-order-pending-upload').className).not.toMatch(/overflow-x|w-\[|min-w-\[/);
  });

  test('FREQ-530-AC-02: ダイアログはモバイルで全画面（fullScreenOnMobile）。入力欄は幅いっぱい', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: '書類を追加' }));
    const dialog = screen.getByRole('dialog', { name: '書類を追加' });
    for (const label of ['取引日', '金額（円）', '取引先', 'ファイル']) expect(within(dialog).getByLabelText(label).className).toMatch(/w-full/);
    expect(dialog.parentElement).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});
