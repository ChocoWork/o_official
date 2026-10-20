import {
  EMPTY_LINE_INPUT,
  availabilityMessageOf,
  buildConfirmSummary,
  buildSubmitBody,
  firstErrorFieldId,
  formatMonthDay,
  hasSendingPhotos,
  itemLabel,
  lineDomId,
  lineKey,
  normalizeLine,
  reasonOptionsOf,
  resolutionOptionsOf,
  shippingTermsOf,
  validateDraft,
  variantChoicesOf,
  type LineErrors,
  type LineInput,
  type PickedPhoto,
  type RequestDraft,
  type RequestPhotos,
} from '@/features/account/returns/return-request-model';
import {
  BELT,
  BLOUSE,
  COAT_PAST_DEADLINE,
  PANTS,
  REASONS,
  SCARF,
  materials,
  type Materials,
} from './return-request-fixtures';

const K_BLOUSE = lineKey('ful-1', 'item-blouse');
const K_PANTS = lineKey('ful-1', 'item-pants');
const K_SCARF = lineKey('ful-1', 'item-scarf');
const K_COAT = lineKey('ful-2', 'item-coat');

/** 手数料の添え書き（C-5。仕様書 6-4）。返金の品がある時と、交換だけの時 */
const FEE_NOTE_WITH_REFUND = '手数料はご返金から差し引きます。差し引けない分は、お支払いのご案内をお送りします。';
const FEE_NOTE_EXCHANGE_ONLY = '手数料は、お支払いのご案内をお送りします。お支払いの後に交換の品をお送りします。';

/** 選んだ品の入力（「この商品を申し込む」にチェックを入れた状態から始める） */
function input(overrides: Partial<LineInput> = {}): LineInput {
  return { ...EMPTY_LINE_INPUT, selected: true, ...overrides };
}

function photo(status: PickedPhoto['status'], uploadId: string | null): PickedPhoto {
  return { id: `p-${uploadId ?? 'sending'}`, status, uploadId, previewUrl: null };
}

function withFees(fees: Partial<Materials['fees']>): Materials {
  return materials({ fees: { customerPaidMethod: 'customer_ships', shopLabelFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0, ...fees } });
}

describe('formatMonthDay・itemLabel・lineDomId', () => {
  it.each([
    ['2026-10-10T01:30:00.000Z', '10月10日'],
    // 日本時間で数える: 2026-10-01 16:00Z は日本時間の 10月2日 01:00
    ['2026-10-01T16:00:00.000Z', '10月2日'],
    ['2026-12-31T15:00:00.000Z', '1月1日'],
    ['読めない日付', '読めない日付'],
  ])('発送の日時 %s は「%s」', (iso, expected) => {
    expect(formatMonthDay(iso)).toBe(expected);
  });

  it.each([
    ['シルクブラウス', '白', 'M', 'シルクブラウス（白 / M）'],
    ['ウールパンツ', null, '2', 'ウールパンツ（2）'],
    ['レザーベルト', '茶', null, 'レザーベルト（茶）'],
    ['ストール', null, null, 'ストール'],
  ])('品の名前 %s／%s／%s は「%s」', (name, color, size, expected) => {
    expect(itemLabel(name, color, size)).toBe(expected);
  });

  it('行の印は DOM の id に使える形にする', () => {
    expect(lineDomId(K_BLOUSE)).toBe('rr-ful-1-item-blouse');
    expect(lineDomId('a:b c/d')).toBe('rr-a-b-c-d');
  });
});

describe('reasonOptionsOf と resolutionOptionsOf', () => {
  it('ふつうの品は、窓口が出す9つの理由を窓口の並びのまま選べる', () => {
    expect(reasonOptionsOf(materials(), BLOUSE).map((option) => option.reason)).toEqual([
      'defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style', 'not_as_described', 'unwanted', 'other',
    ]);
  });

  it('返品不可の品は「破損・不良」と「注文と違う品が届いた」の2つだけ', () => {
    expect(reasonOptionsOf(materials(), SCARF).map((option) => option.reason)).toEqual(['defective', 'wrong_item']);
  });

  it('交換にできる色・サイズが無い品では、ご希望が交換だけの理由（サイズが大きい）を選べない', () => {
    const reasons = reasonOptionsOf(materials(), BELT).map((option) => option.reason);
    expect(reasons).toHaveLength(8);
    expect(reasons).not.toContain('size_too_large');
  });

  it('窓口が出さない理由は選べない', () => {
    const shown = materials({ reasons: REASONS.filter((setting) => setting.reason !== 'other' && setting.reason !== 'unwanted') });
    const reasons = reasonOptionsOf(shown, PANTS).map((option) => option.reason);
    expect(reasons).not.toContain('other');
    expect(reasons).not.toContain('unwanted');
    expect(reasons).toHaveLength(7);
  });

  it.each([
    ['refund_and_exchange', true, ['refund', 'exchange']],
    ['refund_and_exchange', false, ['refund']],
    ['exchange_only', true, ['exchange']],
    ['exchange_only', false, []],
    ['refund_only', true, ['refund']],
    ['refund_only', false, ['refund']],
  ] as const)('ご希望の設定 %s（交換にできる色・サイズ: %s）で選べるのは %j', (rule, usable, expected) => {
    expect(resolutionOptionsOf(rule, usable)).toEqual(expected);
  });
});

describe('variantChoicesOf', () => {
  const statusesOf = (reason: string, quantity: number) => {
    const setting = REASONS.find((candidate) => candidate.reason === reason);
    if (!setting) throw new Error('理由が無い');
    return variantChoicesOf(materials(), BLOUSE, setting, quantity).map((choice) => [choice.variant.variantId, choice.status]);
  };

  it('在庫が申し込む数以上なら在庫から。足りない色・サイズは、在庫の無い交換が「作って送る」の理由なら作って送る', () => {
    expect(statusesOf('defective', 1)).toEqual([[101, 'in_stock'], [102, 'make'], [104, 'in_stock']]);
    expect(statusesOf('defective', 2)).toEqual([[101, 'in_stock'], [102, 'make'], [104, 'make']]);
  });

  it('在庫の無い交換が「断る」の理由では、在庫が足りない色・サイズは選べない', () => {
    expect(statusesOf('size_too_small', 1)).toEqual([[101, 'in_stock'], [102, 'unavailable'], [104, 'in_stock']]);
    expect(statusesOf('size_too_small', 2)).toEqual([[101, 'in_stock'], [102, 'unavailable'], [104, 'unavailable']]);
  });
});

describe('normalizeLine', () => {
  it.each([
    [9, 2],
    [2, 2],
    [1.7, 1],
    [0, 1],
    [-3, 1],
    [Number.NaN, 1],
  ])('数 %s は、選べる数（2）までの 1 以上に収まり %s になる', (quantity, expected) => {
    expect(normalizeLine(materials(), BLOUSE, input({ quantity })).quantity).toBe(expected);
  });

  it('その品で選べない理由は未選択に戻す（返品不可の品の「不要になった」）。選べる理由は残す', () => {
    expect(normalizeLine(materials(), SCARF, input({ reason: 'unwanted' })).reason).toBe('');
    expect(normalizeLine(materials(), SCARF, input({ reason: 'defective' })).reason).toBe('defective');
  });

  it('理由を選ぶまではご希望は返金。理由の設定が許さないご希望は、許す先頭の物にする', () => {
    expect(normalizeLine(materials(), BLOUSE, input({ resolution: 'exchange' })).resolution).toBe('refund');
    expect(normalizeLine(materials(), BLOUSE, input({ reason: 'color', resolution: 'exchange' })).resolution).toBe('refund');
    expect(normalizeLine(materials(), BLOUSE, input({ reason: 'size_too_large', resolution: 'refund' })).resolution).toBe('exchange');
    expect(normalizeLine(materials(), BLOUSE, input({ reason: 'defective', resolution: 'exchange' })).resolution).toBe('exchange');
  });

  it('選べる交換の色・サイズは残し、選べなくなった物（数を増やして在庫が足りなくなった・返金に変えた・別の商品の物）は未選択に戻す', () => {
    const exchange = { reason: 'size_too_small', resolution: 'exchange' } as const;
    expect(normalizeLine(materials(), BLOUSE, input({ ...exchange, variantId: '104', quantity: 1 })).variantId).toBe('104');
    expect(normalizeLine(materials(), BLOUSE, input({ ...exchange, variantId: '104', quantity: 2 })).variantId).toBe('');
    expect(normalizeLine(materials(), BLOUSE, input({ reason: 'size_too_small', resolution: 'refund', variantId: '101' })).variantId).toBe('');
    expect(normalizeLine(materials(), BLOUSE, input({ ...exchange, variantId: '201' })).variantId).toBe('');
  });

  it('在庫が足りなくても、作って送る理由なら交換の色・サイズを残す', () => {
    const line = normalizeLine(materials(), BLOUSE, input({ reason: 'defective', resolution: 'exchange', variantId: '102', quantity: 2 }));
    expect(line.variantId).toBe('102');
  });

  it('詳しい内容と選んだ印は変えない', () => {
    const line = normalizeLine(materials(), BLOUSE, input({ reason: 'other', note: ' 色が違います ' }));
    expect(line).toMatchObject({ selected: true, note: ' 色が違います ' });
  });
});

describe('validateDraft', () => {
  it('何も選んでいなければ、商品を選ぶ誤りで進めない', () => {
    expect(validateDraft(materials(), {}, {})).toEqual({ valid: false, noneSelected: true, lines: {} });
  });

  it('理由が未選択なら理由の誤り', () => {
    const result = validateDraft(materials(), { [K_PANTS]: input() }, {});
    expect(result).toEqual({ valid: false, noneSelected: false, lines: { [K_PANTS]: { reason: '理由を選んでください。' } } });
  });

  it('「破損・不良」と「その他」は詳しい内容が必須で、空白だけは入っていないのと同じ。ほかの理由は任意', () => {
    const NOTE_ERROR = '詳しい内容を入れてください（300字まで）。';
    const photos: RequestPhotos = { [K_PANTS]: [photo('sent', 'up-1')] };
    expect(validateDraft(materials(), { [K_PANTS]: input({ reason: 'defective', note: '   ' }) }, photos).lines[K_PANTS]).toEqual({ note: NOTE_ERROR });
    expect(validateDraft(materials(), { [K_PANTS]: input({ reason: 'other', note: '' }) }, photos).lines[K_PANTS]).toEqual({ note: NOTE_ERROR });
    expect(validateDraft(materials(), { [K_PANTS]: input({ reason: 'defective', note: '糸がほつれています' }) }, photos).valid).toBe(true);
    expect(validateDraft(materials(), { [K_PANTS]: input({ reason: 'size_too_small' }) }, {}).valid).toBe(true);
  });

  it('写真が必須の理由は、送り終えた写真が1枚以上要る。送っている途中の写真は数えない', () => {
    const draft: RequestDraft = { [K_PANTS]: input({ reason: 'defective', note: '糸がほつれています' }) };
    const PHOTO_ERROR = '写真を1枚以上選んでください。';
    expect(validateDraft(materials(), draft, {}).lines[K_PANTS]).toEqual({ photos: PHOTO_ERROR });
    expect(validateDraft(materials(), draft, { [K_PANTS]: [photo('sending', null)] }).lines[K_PANTS]).toEqual({ photos: PHOTO_ERROR });
    expect(validateDraft(materials(), draft, { [K_PANTS]: [photo('sending', null), photo('sent', 'up-1')] }).valid).toBe(true);
  });

  it('写真が任意・なしの理由は、写真が無くても通る', () => {
    expect(validateDraft(materials(), { [K_PANTS]: input({ reason: 'wrong_item' }) }, {}).valid).toBe(true);
    expect(validateDraft(materials(), { [K_PANTS]: input({ reason: 'size_too_small' }) }, {}).valid).toBe(true);
  });

  it('ご希望が交換で、色・サイズが未選択なら誤り。選べば通る', () => {
    const draft = (variantId: string): RequestDraft => ({
      [K_BLOUSE]: input({ reason: 'size_too_small', resolution: 'exchange', variantId }),
    });
    expect(validateDraft(materials(), draft(''), {}).lines[K_BLOUSE]).toEqual({ variant: '交換する色・サイズを選んでください。' });
    expect(validateDraft(materials(), draft('101'), {}).valid).toBe(true);
  });

  it('1行に誤りが重なれば全部を返し、別の行の誤りも一緒に返す', () => {
    const result = validateDraft(
      materials(),
      {
        [K_BLOUSE]: input({ reason: 'defective', resolution: 'exchange' }),
        [K_PANTS]: input(),
      },
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.lines[K_BLOUSE]).toEqual({
      note: '詳しい内容を入れてください（300字まで）。',
      photos: '写真を1枚以上選んでください。',
      variant: '交換する色・サイズを選んでください。',
    });
    expect(result.lines[K_PANTS]).toEqual({ reason: '理由を選んでください。' });
  });

  it('選んでいない行と、選べない行（期限切れなど）は、入力があっても見ない', () => {
    const draft: RequestDraft = {
      [K_BLOUSE]: { ...EMPTY_LINE_INPUT, reason: 'defective' },
      [K_COAT]: input(),
      [K_PANTS]: input({ reason: 'size_too_small' }),
    };
    expect(validateDraft(materials(), draft, {})).toEqual({ valid: true, noneSelected: false, lines: {} });
    expect(COAT_PAST_DEADLINE.state).toBe('past_deadline');
  });
});

describe('firstErrorFieldId', () => {
  it('材料の並び（先の発送・先の品）の最初の誤りの入力欄を返す。1行の中では 理由 → 詳しい内容 → 写真 → 交換の色・サイズ', () => {
    const lines = (overrides: Record<string, LineErrors>) => ({ valid: false, noneSelected: false, lines: overrides });
    expect(firstErrorFieldId(materials(), lines({ [K_PANTS]: { reason: 'x' }, [K_BLOUSE]: { note: 'x', photos: 'x' } }))).toBe(`${lineDomId(K_BLOUSE)}-note`);
    expect(firstErrorFieldId(materials(), lines({ [K_BLOUSE]: { reason: 'x', note: 'x' } }))).toBe(`${lineDomId(K_BLOUSE)}-reason`);
    expect(firstErrorFieldId(materials(), lines({ [K_BLOUSE]: { photos: 'x', variant: 'x' } }))).toBe(`${lineDomId(K_BLOUSE)}-photo-button`);
    expect(firstErrorFieldId(materials(), lines({ [K_BLOUSE]: { variant: 'x' } }))).toBe(`${lineDomId(K_BLOUSE)}-variant`);
  });

  it('誤りが無い（商品を選ぶ誤りだけ）時は null', () => {
    expect(firstErrorFieldId(materials(), { valid: false, noneSelected: true, lines: {} })).toBeNull();
  });
});

describe('buildSubmitBody', () => {
  const draft: RequestDraft = {
    [K_PANTS]: input({ reason: 'size_too_small', note: '   ' }),
    [K_BLOUSE]: input({ quantity: 2, reason: 'defective', note: '  縫い目がほつれています  ', resolution: 'exchange', variantId: '102' }),
    [K_COAT]: input({ reason: 'defective' }),
    [K_SCARF]: { ...EMPTY_LINE_INPUT, reason: 'defective' },
  };
  const photos: RequestPhotos = {
    [K_BLOUSE]: [photo('sent', 'up-1'), photo('sending', null), photo('sent', 'up-2')],
    // 理由を変えて写真が「なし」になった行に残った写真は送らない
    [K_PANTS]: [photo('sent', 'up-9')],
  };

  it('選んだ行を材料の並び（発送 → 品）で、窓口の本文の形にする', () => {
    expect(buildSubmitBody(materials(), draft, photos, 'key-1')).toEqual({
      requestKey: 'key-1',
      lines: [
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-blouse', quantity: 2, reason: 'defective', customerNote: '縫い目がほつれています',
          requestedResolution: 'exchange', requestedExchangeVariantId: 102, photoUploadIds: ['up-1', 'up-2'],
        },
        {
          fulfillmentId: 'ful-1', orderItemId: 'item-pants', quantity: 1, reason: 'size_too_small', customerNote: null,
          requestedResolution: 'refund', requestedExchangeVariantId: null, photoUploadIds: [],
        },
      ],
    });
  });

  it('選んでいない行・選べない行は入れない', () => {
    const body = buildSubmitBody(materials(), draft, photos, 'key-1');
    expect(body.lines.map((line) => line.orderItemId)).toEqual(['item-blouse', 'item-pants']);
  });

  it('理由が未選択の行は入れない（確かめを通った後に呼ぶので、通常は起きない）', () => {
    expect(buildSubmitBody(materials(), { [K_PANTS]: input() }, {}, 'key-1').lines).toEqual([]);
  });
});

describe('shippingTermsOf（返送料の負担と方法の仮の値。P5）', () => {
  it('選んだ理由のどれかが「お店」の負担なら、負担はお店で、方法は着払い（設定の送り方に依らない）', () => {
    const shop = withFees({ customerPaidMethod: 'shop_label' });
    expect(shippingTermsOf(shop, ['defective'])).toEqual({ payer: 'shop', method: 'customer_ships' });
    expect(shippingTermsOf(shop, ['size_too_small', 'wrong_item'])).toEqual({ payer: 'shop', method: 'customer_ships' });
  });

  it('すべてお客様の負担なら、方法は設定の「お客様の負担の時の送り方」', () => {
    expect(shippingTermsOf(withFees({ customerPaidMethod: 'customer_ships' }), ['size_too_small', 'color'])).toEqual({
      payer: 'customer', method: 'customer_ships',
    });
    expect(shippingTermsOf(withFees({ customerPaidMethod: 'shop_label' }), ['size_too_small'])).toEqual({
      payer: 'customer', method: 'shop_label',
    });
  });
});

describe('buildConfirmSummary', () => {
  const draft: RequestDraft = {
    [K_BLOUSE]: input({ quantity: 2, reason: 'defective', note: '  縫い目がほつれています  ', resolution: 'exchange', variantId: '102' }),
    [K_PANTS]: input({ reason: 'size_too_small' }),
  };
  const photos: RequestPhotos = { [K_BLOUSE]: [photo('sent', 'up-1'), photo('sent', 'up-2')], [K_PANTS]: [photo('sent', 'up-9')] };

  it('品ごとに、品・数、理由、詳しい内容、ご希望、写真の枚数の文を作る（空の物は null）', () => {
    expect(buildConfirmSummary(materials(), draft, photos).lines).toEqual([
      {
        key: K_BLOUSE,
        title: 'シルクブラウス（白 / M） × 2',
        reason: '理由: 破損・不良',
        note: '詳しい内容: 縫い目がほつれています',
        wish: 'ご希望: 交換（白 / L）',
        photos: '写真 2枚',
      },
      {
        key: K_PANTS,
        title: 'ウールパンツ（2） × 1',
        reason: '理由: サイズが小さい',
        note: null,
        wish: 'ご希望: 返金',
        photos: null,
      },
    ]);
  });

  it('返送料: 選んだ理由にお店の負担があれば「当店が負担」、無ければ設定の送り方どおり', () => {
    expect(buildConfirmSummary(withFees({}), draft, photos).shipping).toBe('返送料: 当店が負担します（着払いでお送りください）');
    const customerOnly: RequestDraft = { [K_PANTS]: input({ reason: 'size_too_small' }) };
    expect(buildConfirmSummary(withFees({}), customerOnly, {}).shipping).toBe('返送料: お客様のご負担です');
    expect(buildConfirmSummary(withFees({ customerPaidMethod: 'shop_label', shopLabelFee: 800 }), customerOnly, {}).shipping).toBe(
      '返送料: ￥800（ご返金から差し引きます）',
    );
  });

  it('返送料: お客様の負担でお店の送り状の定額が0円なら、金額は出さず送り状の文だけを出す。お店の負担の時は今までどおり', () => {
    const free = withFees({ customerPaidMethod: 'shop_label', shopLabelFee: 0 });
    const customerOnly: RequestDraft = { [K_PANTS]: input({ reason: 'size_too_small' }) };

    expect(buildConfirmSummary(free, customerOnly, {}).shipping).toBe('返送料: 当店がご用意する送り状でお送りください。');
    expect(buildConfirmSummary(free, draft, photos).shipping).toBe('返送料: 当店が負担します（着払いでお送りください）');
  });

  it('手数料は、設定で使う物（0より大きい物）のうち、この申し込みに関わる物だけ出す', () => {
    const fees = withFees({ restockingFeePercent: 10, exchangeFee: 500, exchangeShippingFee: 1200 });
    const refundOnly: RequestDraft = { [K_PANTS]: input({ reason: 'size_too_small' }) };
    const exchangeOnly: RequestDraft = { [K_PANTS]: input({ reason: 'size_too_small', resolution: 'exchange', variantId: '201' }) };

    expect(buildConfirmSummary(fees, draft, photos)).toMatchObject({
      fees: ['返品の手数料: ご返金の商品の額の 10%', '交換の手数料: ￥500', '交換の送料: ￥1,200'],
      feeNote: FEE_NOTE_WITH_REFUND,
    });
    expect(buildConfirmSummary(fees, refundOnly, {})).toMatchObject({ fees: ['返品の手数料: ご返金の商品の額の 10%'], feeNote: FEE_NOTE_WITH_REFUND });
    expect(buildConfirmSummary(fees, exchangeOnly, {})).toMatchObject({ fees: ['交換の手数料: ￥500', '交換の送料: ￥1,200'] });
  });

  it('手数料の添え書き: 返金の品がある時（交換と一緒でも）は「差し引けない分は、お支払いのご案内」、交換だけの時は「お支払いのご案内。お支払いの後に交換の品」', () => {
    const fees = withFees({ exchangeFee: 500 });
    const exchangeOnly: RequestDraft = { [K_PANTS]: input({ reason: 'size_too_small', resolution: 'exchange', variantId: '201' }) };
    const withRefund: RequestDraft = { ...exchangeOnly, [K_BLOUSE]: input({ reason: 'size_too_small' }) };

    expect(buildConfirmSummary(fees, exchangeOnly, {}).feeNote).toBe(FEE_NOTE_EXCHANGE_ONLY);
    expect(buildConfirmSummary(fees, withRefund, {}).feeNote).toBe(FEE_NOTE_WITH_REFUND);
    // 手数料が1つも無ければ、交換だけでも添え書きは出さない
    expect(buildConfirmSummary(withFees({}), exchangeOnly, {}).feeNote).toBeNull();
  });

  it('使わない手数料（0）は出さず、1つも無ければ注意の文も出さない', () => {
    expect(buildConfirmSummary(withFees({}), draft, photos)).toMatchObject({ fees: [], feeNote: null });
    expect(buildConfirmSummary(withFees({ exchangeFee: 500 }), { [K_PANTS]: input({ reason: 'size_too_small' }) }, {})).toMatchObject({
      fees: [],
      feeNote: null,
    });
  });

  it('写真が「なし」の理由の行に残った写真は数えない', () => {
    const summary = buildConfirmSummary(materials(), { [K_PANTS]: input({ reason: 'size_too_small' }) }, { [K_PANTS]: [photo('sent', 'up-9')] });
    expect(summary.lines[0].photos).toBeNull();
  });
});

describe('hasSendingPhotos', () => {
  it('画面に写真の欄を出している行（選んだ品で、理由の設定が写真を求める行）の、送っている途中の写真だけを数える', () => {
    const draft: RequestDraft = {
      [K_PANTS]: input({ reason: 'defective' }),
      // 写真が「なし」の理由に変えた行。写真の欄は隠れている
      [K_BLOUSE]: input({ reason: 'size_too_small' }),
      // チェックを外した行。写真の欄は隠れている
      [K_SCARF]: { ...EMPTY_LINE_INPUT, reason: 'defective' },
    };

    expect(hasSendingPhotos(materials(), draft, { [K_PANTS]: [photo('sent', 'up-1'), photo('sending', null)] })).toBe(true);
    expect(hasSendingPhotos(materials(), draft, { [K_PANTS]: [photo('sent', 'up-1')] })).toBe(false);
    expect(hasSendingPhotos(materials(), draft, {})).toBe(false);
    expect(hasSendingPhotos(materials(), draft, { [K_BLOUSE]: [photo('sending', null)], [K_SCARF]: [photo('sending', null)] })).toBe(false);
  });
});

describe('availabilityMessageOf', () => {
  it.each([
    [{ returns: 'available', endedOn: null }, null],
    [{ returns: 'closed', endedOn: null }, '現在、返品・交換のお申し込みを受け付けていません。'],
    [{ returns: 'ended', endedOn: '2026-10-11' }, '返品・交換の受付は 10月11日 で終わりました'],
    [{ returns: 'ended', endedOn: null }, 'この注文は、返品・交換のお申し込みを受け付けていません。'],
    [{ returns: 'none', endedOn: null }, 'この注文は、返品・交換のお申し込みを受け付けていません。'],
  ] as const)('受付の有無 %j の文は %j', (availability, expected) => {
    expect(availabilityMessageOf(availability)).toBe(expected);
  });
});
