// 勘定科目マスタ。docs/Other/財務.md の「勘定科目」テーブルと1対1で対応する。
// 表を更新したらこのファイルも合わせて更新すること。
// cashOut / cashIn がどちらも false の科目は非資金取引（決算整理・振替専用）で、
// 取引管理のプルダウンには表示しない。

export type BusinessType = "soleProprietor" | "corporation";

// 科目の適用形態。common はどちらの事業形態でも使う。
export type AccountScope = BusinessType | "common";

export type Account = {
  /** 表示名を変更しても集計が壊れないための不変キー */
  code: string;
  /** UI とデータ保存に使う名称 */
  name: string;
  /** 決算書のどの行に集計するか */
  section: string;
  /** 出金入力の勘定科目として選択できるか */
  cashOut: boolean;
  /** 入金入力の勘定科目として選択できるか */
  cashIn: boolean;
  scope: AccountScope;
};

export const ACCOUNTS: readonly Account[] = [
  { code: "1010", name: "現金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1020", name: "小口現金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1030", name: "当座預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1040", name: "普通預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1050", name: "定期預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1060", name: "定期積金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1070", name: "その他の預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1080", name: "電子マネー", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1110", name: "受取手形", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1120", name: "売掛金", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1130", name: "クレジット売掛金", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1140", name: "電子記録債権", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1210", name: "有価証券", section: "有価証券", cashOut: true, cashIn: true, scope: "common" },
  { code: "1310", name: "商品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1320", name: "製品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1330", name: "材料", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1340", name: "仕掛品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1350", name: "貯蔵品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1410", name: "前払金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1420", name: "前払費用", section: "その他流動資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1430", name: "未収金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1440", name: "未収賃貸料", section: "その他流動資産", cashOut: false, cashIn: true, scope: "common" },
  { code: "1450", name: "貸付金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1460", name: "立替金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1470", name: "仮払金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1480", name: "仮払消費税", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1490", name: "未収還付法人税等", section: "その他流動資産", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "1510", name: "建物", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1515", name: "附属設備", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1520", name: "構築物", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1525", name: "機械装置", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1530", name: "車両運搬具", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1535", name: "工具器具備品", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1540", name: "船舶", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1545", name: "航空機", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1550", name: "一括償却資産", section: "有形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1555", name: "少額減価償却資産", section: "有形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1560", name: "土地", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1570", name: "建設仮勘定", section: "有形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1590", name: "減価償却累計額", section: "有形固定資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1610", name: "ソフトウェア", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1615", name: "ソフトウェア仮勘定", section: "無形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1620", name: "商標権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1625", name: "意匠権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1630", name: "特許権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1635", name: "実用新案権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1640", name: "のれん", section: "無形固定資産", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "1650", name: "電話加入権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1660", name: "借地権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1670", name: "公共施設負担金", section: "無形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1680", name: "施設利用権", section: "無形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1710", name: "差入保証金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1715", name: "敷金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1720", name: "預託金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1730", name: "出資金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1740", name: "保険積立金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1750", name: "長期貸付金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1760", name: "長期前払費用", section: "投資その他の資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1770", name: "投資有価証券", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "corporation" },
  { code: "1810", name: "開業費", section: "繰延資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1820", name: "創立費", section: "繰延資産", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "1830", name: "開発費", section: "繰延資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1840", name: "株式交付費", section: "繰延資産", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "1910", name: "事業主貸", section: "事業主貸", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "1920", name: "資産譲渡損", section: "事業主貸", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "1990", name: "未確定勘定", section: "諸口", cashOut: false, cashIn: false, scope: "common" },
  { code: "2010", name: "支払手形", section: "仕入債務", cashOut: true, cashIn: false, scope: "common" },
  { code: "2020", name: "買掛金", section: "仕入債務", cashOut: true, cashIn: true, scope: "common" },
  { code: "2030", name: "電子記録債務", section: "仕入債務", cashOut: true, cashIn: false, scope: "common" },
  { code: "2110", name: "短期借入金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2120", name: "役員借入金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "corporation" },
  { code: "2130", name: "未払金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2140", name: "未払費用", section: "その他流動負債", cashOut: true, cashIn: false, scope: "common" },
  { code: "2150", name: "前受金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2160", name: "預り金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2170", name: "仮受金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2180", name: "仮受消費税", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2190", name: "未払消費税", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2200", name: "未払法人税等", section: "その他流動負債", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "2210", name: "未払配当金", section: "その他流動負債", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "2220", name: "受入保証金・敷金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2230", name: "商品券", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2240", name: "前受収益", section: "その他流動負債", cashOut: false, cashIn: true, scope: "common" },
  { code: "2250", name: "賞与引当金", section: "その他流動負債", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "2260", name: "貸倒引当金", section: "その他流動負債", cashOut: false, cashIn: false, scope: "common" },
  { code: "2510", name: "長期借入金", section: "固定負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2520", name: "社債", section: "固定負債", cashOut: true, cashIn: true, scope: "corporation" },
  { code: "2530", name: "退職給付引当金", section: "固定負債", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "2540", name: "長期未払金", section: "固定負債", cashOut: true, cashIn: false, scope: "common" },
  { code: "2910", name: "元入金", section: "資本の部", cashOut: false, cashIn: false, scope: "soleProprietor" },
  { code: "2920", name: "事業主借", section: "事業主借", cashOut: false, cashIn: true, scope: "soleProprietor" },
  { code: "3010", name: "資本金", section: "純資産の部", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "3020", name: "資本準備金", section: "純資産の部", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "3030", name: "利益準備金", section: "純資産の部", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "3040", name: "繰越利益剰余金", section: "純資産の部", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "3050", name: "自己株式", section: "純資産の部", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "4010", name: "売上高", section: "売上（収入）金額", cashOut: false, cashIn: true, scope: "common" },
  { code: "4020", name: "売上値引・返品", section: "売上（収入）金額", cashOut: true, cashIn: false, scope: "common" },
  { code: "4030", name: "家事消費等", section: "売上（収入）金額", cashOut: false, cashIn: false, scope: "soleProprietor" },
  { code: "4040", name: "雑収入", section: "売上（収入）金額", cashOut: false, cashIn: true, scope: "common" },
  { code: "5010", name: "期首商品棚卸高", section: "期首商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5015", name: "期首材料棚卸高", section: "期首商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5020", name: "仕入高", section: "当期仕入高", cashOut: true, cashIn: false, scope: "common" },
  { code: "5030", name: "仕入値引・返品", section: "当期仕入高", cashOut: false, cashIn: true, scope: "common" },
  { code: "5040", name: "期末商品棚卸高", section: "期末商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5045", name: "期末材料棚卸高", section: "期末商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5050", name: "外注加工費", section: "当期仕入高", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "6010", name: "租税公課", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6020", name: "荷造運賃", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6030", name: "水道光熱費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6040", name: "旅費交通費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6050", name: "通信費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6060", name: "広告宣伝費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6070", name: "販売促進費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6080", name: "接待交際費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6090", name: "会議費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6100", name: "損害保険料", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6110", name: "修繕費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6120", name: "消耗品費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6130", name: "事務用品費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6140", name: "減価償却費", section: "経費", cashOut: false, cashIn: false, scope: "common" },
  { code: "6150", name: "繰延資産償却", section: "経費", cashOut: false, cashIn: false, scope: "common" },
  { code: "6160", name: "福利厚生費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6170", name: "法定福利費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6180", name: "給料賃金", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6190", name: "役員報酬", section: "経費", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "6200", name: "賞与", section: "経費", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "6210", name: "退職給与", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6220", name: "外注工賃", section: "経費", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "6230", name: "支払報酬", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6240", name: "利子割引料", section: "経費", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "6250", name: "地代家賃", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6260", name: "リース料", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6270", name: "車両費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6280", name: "支払手数料", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6290", name: "研修採用費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6300", name: "新聞図書費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6310", name: "諸会費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6320", name: "寄附金", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6330", name: "貸倒金（損失）", section: "経費", cashOut: false, cashIn: false, scope: "common" },
  { code: "6340", name: "雑費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "7010", name: "受取利息", section: "営業外収益", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "7020", name: "受取配当金", section: "営業外収益", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "7030", name: "為替差益", section: "営業外収益", cashOut: false, cashIn: false, scope: "common" },
  { code: "7040", name: "補助金・助成金", section: "営業外収益", cashOut: false, cashIn: true, scope: "common" },
  { code: "7050", name: "受取家賃", section: "営業外収益", cashOut: false, cashIn: true, scope: "common" },
  { code: "7060", name: "貸倒引当金戻入", section: "繰戻額等", cashOut: false, cashIn: false, scope: "common" },
  { code: "7510", name: "支払利息", section: "営業外費用", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "7520", name: "為替差損", section: "営業外費用", cashOut: false, cashIn: false, scope: "common" },
  { code: "7530", name: "雑損失", section: "営業外費用", cashOut: true, cashIn: false, scope: "common" },
  { code: "8010", name: "固定資産売却益", section: "特別利益", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "8020", name: "固定資産売却損", section: "特別損失", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "8030", name: "固定資産除却損", section: "特別損失", cashOut: false, cashIn: false, scope: "common" },
  { code: "8040", name: "災害損失", section: "特別損失", cashOut: true, cashIn: false, scope: "common" },
  { code: "9010", name: "専従者給与", section: "繰入額等", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "9020", name: "貸倒引当金繰入", section: "繰入額等", cashOut: false, cashIn: false, scope: "common" },
  { code: "9030", name: "その他引当金繰入", section: "繰入額等", cashOut: false, cashIn: false, scope: "common" },
  { code: "9040", name: "青色申告特別控除", section: "繰入額等", cashOut: false, cashIn: false, scope: "soleProprietor" },
  { code: "9510", name: "法人税・住民税及び事業税", section: "税金", cashOut: true, cashIn: false, scope: "corporation" },
];

function matchesBusinessType(account: Account, businessType: BusinessType) {
  return account.scope === "common" || account.scope === businessType;
}

/** 出金（支出）入力で選べる勘定科目 */
export function expenseAccounts(businessType: BusinessType): Account[] {
  return ACCOUNTS.filter(
    (account) => account.cashOut && matchesBusinessType(account, businessType),
  );
}

/** 入金（収入）入力で選べる勘定科目 */
export function incomeAccounts(businessType: BusinessType): Account[] {
  return ACCOUNTS.filter(
    (account) => account.cashIn && matchesBusinessType(account, businessType),
  );
}
