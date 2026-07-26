// 勘定科目マスタ。docs/Other/財務.md の「勘定科目」テーブルと1対1で対応する。
// 表を更新したらこのファイルも合わせて更新すること。
// cashOut / cashIn がどちらも false の科目は非資金取引（決算整理・振替専用）で、
// 取引管理のプルダウンには表示しない。

export type BusinessType = "soleProprietor" | "corporation";

// 科目の適用形態。common はどちらの事業形態でも使う。
export type AccountScope = BusinessType | "common";

// 会計区分。BS（asset / liability / equity）と PL（revenue / expense）の検算軸。
export type AccountType =
  | "asset"
  | "liability"
  | "equity"
  | "revenue"
  | "expense";

// 増加がどちら側に立つか。評価性・控除性の科目（減価償却累計額、売上値引、
// 期末棚卸高など）は会計区分から機械的に決まらないため個別に持つ。
export type AccountSide = "debit" | "credit";

export type Account = {
  /** 表示名を変更しても集計が壊れないための不変キー */
  code: string;
  /** 会計区分（資産/負債/純資産/収益/費用） */
  type: AccountType;
  /** 増加がどちら側か（借方/貸方） */
  normalSide: AccountSide;
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
  { code: "1010", type: "asset", normalSide: "debit", name: "現金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1020", type: "asset", normalSide: "debit", name: "小口現金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1030", type: "asset", normalSide: "debit", name: "当座預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1040", type: "asset", normalSide: "debit", name: "普通預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1050", type: "asset", normalSide: "debit", name: "定期預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1060", type: "asset", normalSide: "debit", name: "定期積金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1070", type: "asset", normalSide: "debit", name: "その他の預金", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1080", type: "asset", normalSide: "debit", name: "電子マネー", section: "現金及び預金", cashOut: true, cashIn: true, scope: "common" },
  { code: "1110", type: "asset", normalSide: "debit", name: "受取手形", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1120", type: "asset", normalSide: "debit", name: "売掛金", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1130", type: "asset", normalSide: "debit", name: "クレジット売掛金", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1140", type: "asset", normalSide: "debit", name: "電子記録債権", section: "売上債権", cashOut: true, cashIn: true, scope: "common" },
  { code: "1210", type: "asset", normalSide: "debit", name: "有価証券", section: "有価証券", cashOut: true, cashIn: true, scope: "common" },
  { code: "1310", type: "asset", normalSide: "debit", name: "商品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1320", type: "asset", normalSide: "debit", name: "製品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1330", type: "asset", normalSide: "debit", name: "材料", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1340", type: "asset", normalSide: "debit", name: "仕掛品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1350", type: "asset", normalSide: "debit", name: "貯蔵品", section: "棚卸資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1410", type: "asset", normalSide: "debit", name: "前払金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1420", type: "asset", normalSide: "debit", name: "前払費用", section: "その他流動資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1430", type: "asset", normalSide: "debit", name: "未収金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1440", type: "asset", normalSide: "debit", name: "未収賃貸料", section: "その他流動資産", cashOut: false, cashIn: true, scope: "common" },
  { code: "1450", type: "asset", normalSide: "debit", name: "貸付金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1460", type: "asset", normalSide: "debit", name: "立替金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1470", type: "asset", normalSide: "debit", name: "仮払金", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1480", type: "asset", normalSide: "debit", name: "仮払消費税", section: "その他流動資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1490", type: "asset", normalSide: "debit", name: "未収還付法人税等", section: "その他流動資産", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "1510", type: "asset", normalSide: "debit", name: "建物", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1515", type: "asset", normalSide: "debit", name: "附属設備", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1520", type: "asset", normalSide: "debit", name: "構築物", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1525", type: "asset", normalSide: "debit", name: "機械装置", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1530", type: "asset", normalSide: "debit", name: "車両運搬具", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1535", type: "asset", normalSide: "debit", name: "工具器具備品", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1540", type: "asset", normalSide: "debit", name: "船舶", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1545", type: "asset", normalSide: "debit", name: "航空機", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1550", type: "asset", normalSide: "debit", name: "一括償却資産", section: "有形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1555", type: "asset", normalSide: "debit", name: "少額減価償却資産", section: "有形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1560", type: "asset", normalSide: "debit", name: "土地", section: "有形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1570", type: "asset", normalSide: "debit", name: "建設仮勘定", section: "有形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1590", type: "asset", normalSide: "credit", name: "減価償却累計額", section: "有形固定資産", cashOut: false, cashIn: false, scope: "common" },
  { code: "1610", type: "asset", normalSide: "debit", name: "ソフトウェア", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1615", type: "asset", normalSide: "debit", name: "ソフトウェア仮勘定", section: "無形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1620", type: "asset", normalSide: "debit", name: "商標権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1625", type: "asset", normalSide: "debit", name: "意匠権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1630", type: "asset", normalSide: "debit", name: "特許権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1635", type: "asset", normalSide: "debit", name: "実用新案権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1640", type: "asset", normalSide: "debit", name: "のれん", section: "無形固定資産", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "1650", type: "asset", normalSide: "debit", name: "電話加入権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1660", type: "asset", normalSide: "debit", name: "借地権", section: "無形固定資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1670", type: "asset", normalSide: "debit", name: "公共施設負担金", section: "無形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1680", type: "asset", normalSide: "debit", name: "施設利用権", section: "無形固定資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1710", type: "asset", normalSide: "debit", name: "差入保証金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1715", type: "asset", normalSide: "debit", name: "敷金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1720", type: "asset", normalSide: "debit", name: "預託金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1730", type: "asset", normalSide: "debit", name: "出資金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1740", type: "asset", normalSide: "debit", name: "保険積立金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1750", type: "asset", normalSide: "debit", name: "長期貸付金", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "common" },
  { code: "1760", type: "asset", normalSide: "debit", name: "長期前払費用", section: "投資その他の資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1770", type: "asset", normalSide: "debit", name: "投資有価証券", section: "投資その他の資産", cashOut: true, cashIn: true, scope: "corporation" },
  { code: "1810", type: "asset", normalSide: "debit", name: "開業費", section: "繰延資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1820", type: "asset", normalSide: "debit", name: "創立費", section: "繰延資産", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "1830", type: "asset", normalSide: "debit", name: "開発費", section: "繰延資産", cashOut: true, cashIn: false, scope: "common" },
  { code: "1840", type: "asset", normalSide: "debit", name: "株式交付費", section: "繰延資産", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "1910", type: "asset", normalSide: "debit", name: "事業主貸", section: "事業主貸", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "1920", type: "asset", normalSide: "debit", name: "資産譲渡損", section: "事業主貸", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "1990", type: "asset", normalSide: "debit", name: "未確定勘定", section: "諸口", cashOut: false, cashIn: false, scope: "common" },
  { code: "2010", type: "liability", normalSide: "credit", name: "支払手形", section: "仕入債務", cashOut: true, cashIn: false, scope: "common" },
  { code: "2020", type: "liability", normalSide: "credit", name: "買掛金", section: "仕入債務", cashOut: true, cashIn: true, scope: "common" },
  { code: "2030", type: "liability", normalSide: "credit", name: "電子記録債務", section: "仕入債務", cashOut: true, cashIn: false, scope: "common" },
  { code: "2110", type: "liability", normalSide: "credit", name: "短期借入金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2120", type: "liability", normalSide: "credit", name: "役員借入金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "corporation" },
  { code: "2130", type: "liability", normalSide: "credit", name: "未払金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2140", type: "liability", normalSide: "credit", name: "未払費用", section: "その他流動負債", cashOut: true, cashIn: false, scope: "common" },
  { code: "2150", type: "liability", normalSide: "credit", name: "前受金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2160", type: "liability", normalSide: "credit", name: "預り金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2170", type: "liability", normalSide: "credit", name: "仮受金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2180", type: "liability", normalSide: "credit", name: "仮受消費税", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2190", type: "liability", normalSide: "credit", name: "未払消費税", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2200", type: "liability", normalSide: "credit", name: "未払法人税等", section: "その他流動負債", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "2210", type: "liability", normalSide: "credit", name: "未払配当金", section: "その他流動負債", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "2220", type: "liability", normalSide: "credit", name: "受入保証金・敷金", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2230", type: "liability", normalSide: "credit", name: "商品券", section: "その他流動負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2240", type: "liability", normalSide: "credit", name: "前受収益", section: "その他流動負債", cashOut: false, cashIn: true, scope: "common" },
  { code: "2250", type: "liability", normalSide: "credit", name: "賞与引当金", section: "その他流動負債", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "2260", type: "liability", normalSide: "credit", name: "貸倒引当金", section: "その他流動負債", cashOut: false, cashIn: false, scope: "common" },
  { code: "2510", type: "liability", normalSide: "credit", name: "長期借入金", section: "固定負債", cashOut: true, cashIn: true, scope: "common" },
  { code: "2520", type: "liability", normalSide: "credit", name: "社債", section: "固定負債", cashOut: true, cashIn: true, scope: "corporation" },
  { code: "2530", type: "liability", normalSide: "credit", name: "退職給付引当金", section: "固定負債", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "2540", type: "liability", normalSide: "credit", name: "長期未払金", section: "固定負債", cashOut: true, cashIn: false, scope: "common" },
  { code: "2910", type: "equity", normalSide: "credit", name: "元入金", section: "資本の部", cashOut: false, cashIn: false, scope: "soleProprietor" },
  { code: "2920", type: "equity", normalSide: "credit", name: "事業主借", section: "事業主借", cashOut: false, cashIn: true, scope: "soleProprietor" },
  { code: "3010", type: "equity", normalSide: "credit", name: "資本金", section: "純資産の部", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "3020", type: "equity", normalSide: "credit", name: "資本準備金", section: "純資産の部", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "3030", type: "equity", normalSide: "credit", name: "利益準備金", section: "純資産の部", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "3040", type: "equity", normalSide: "credit", name: "繰越利益剰余金", section: "純資産の部", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "3050", type: "equity", normalSide: "debit", name: "自己株式", section: "純資産の部", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "4010", type: "revenue", normalSide: "credit", name: "売上高", section: "売上（収入）金額", cashOut: false, cashIn: true, scope: "common" },
  { code: "4020", type: "revenue", normalSide: "debit", name: "売上値引・返品", section: "売上（収入）金額", cashOut: true, cashIn: false, scope: "common" },
  { code: "4030", type: "revenue", normalSide: "credit", name: "家事消費等", section: "売上（収入）金額", cashOut: false, cashIn: false, scope: "soleProprietor" },
  { code: "4040", type: "revenue", normalSide: "credit", name: "雑収入", section: "売上（収入）金額", cashOut: false, cashIn: true, scope: "common" },
  { code: "5010", type: "expense", normalSide: "debit", name: "期首商品棚卸高", section: "期首商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5015", type: "expense", normalSide: "debit", name: "期首材料棚卸高", section: "期首商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5020", type: "expense", normalSide: "debit", name: "仕入高", section: "当期仕入高", cashOut: true, cashIn: false, scope: "common" },
  { code: "5030", type: "expense", normalSide: "credit", name: "仕入値引・返品", section: "当期仕入高", cashOut: false, cashIn: true, scope: "common" },
  { code: "5040", type: "expense", normalSide: "credit", name: "期末商品棚卸高", section: "期末商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5045", type: "expense", normalSide: "credit", name: "期末材料棚卸高", section: "期末商品（製品）棚卸高", cashOut: false, cashIn: false, scope: "common" },
  { code: "5050", type: "expense", normalSide: "debit", name: "外注加工費", section: "当期仕入高", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "6010", type: "expense", normalSide: "debit", name: "租税公課", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6020", type: "expense", normalSide: "debit", name: "荷造運賃", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6030", type: "expense", normalSide: "debit", name: "水道光熱費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6040", type: "expense", normalSide: "debit", name: "旅費交通費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6050", type: "expense", normalSide: "debit", name: "通信費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6060", type: "expense", normalSide: "debit", name: "広告宣伝費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6070", type: "expense", normalSide: "debit", name: "販売促進費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6080", type: "expense", normalSide: "debit", name: "接待交際費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6090", type: "expense", normalSide: "debit", name: "会議費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6100", type: "expense", normalSide: "debit", name: "損害保険料", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6110", type: "expense", normalSide: "debit", name: "修繕費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6120", type: "expense", normalSide: "debit", name: "消耗品費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6130", type: "expense", normalSide: "debit", name: "事務用品費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6140", type: "expense", normalSide: "debit", name: "減価償却費", section: "経費", cashOut: false, cashIn: false, scope: "common" },
  { code: "6150", type: "expense", normalSide: "debit", name: "繰延資産償却", section: "経費", cashOut: false, cashIn: false, scope: "common" },
  { code: "6160", type: "expense", normalSide: "debit", name: "福利厚生費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6170", type: "expense", normalSide: "debit", name: "法定福利費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6180", type: "expense", normalSide: "debit", name: "給料賃金", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6190", type: "expense", normalSide: "debit", name: "役員報酬", section: "経費", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "6200", type: "expense", normalSide: "debit", name: "賞与", section: "経費", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "6210", type: "expense", normalSide: "debit", name: "退職給与", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6220", type: "expense", normalSide: "debit", name: "外注工賃", section: "経費", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "6230", type: "expense", normalSide: "debit", name: "支払報酬", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6240", type: "expense", normalSide: "debit", name: "利子割引料", section: "経費", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "6250", type: "expense", normalSide: "debit", name: "地代家賃", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6260", type: "expense", normalSide: "debit", name: "リース料", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6270", type: "expense", normalSide: "debit", name: "車両費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6280", type: "expense", normalSide: "debit", name: "支払手数料", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6290", type: "expense", normalSide: "debit", name: "研修採用費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6300", type: "expense", normalSide: "debit", name: "新聞図書費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6310", type: "expense", normalSide: "debit", name: "諸会費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6320", type: "expense", normalSide: "debit", name: "寄附金", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "6330", type: "expense", normalSide: "debit", name: "貸倒金（損失）", section: "経費", cashOut: false, cashIn: false, scope: "common" },
  { code: "6340", type: "expense", normalSide: "debit", name: "雑費", section: "経費", cashOut: true, cashIn: false, scope: "common" },
  { code: "7010", type: "revenue", normalSide: "credit", name: "受取利息", section: "営業外収益", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "7020", type: "revenue", normalSide: "credit", name: "受取配当金", section: "営業外収益", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "7030", type: "revenue", normalSide: "credit", name: "為替差益", section: "営業外収益", cashOut: false, cashIn: false, scope: "common" },
  { code: "7040", type: "revenue", normalSide: "credit", name: "補助金・助成金", section: "営業外収益", cashOut: false, cashIn: true, scope: "common" },
  { code: "7050", type: "revenue", normalSide: "credit", name: "受取家賃", section: "営業外収益", cashOut: false, cashIn: true, scope: "common" },
  { code: "7060", type: "revenue", normalSide: "credit", name: "貸倒引当金戻入", section: "繰戻額等", cashOut: false, cashIn: false, scope: "common" },
  { code: "7510", type: "expense", normalSide: "debit", name: "支払利息", section: "営業外費用", cashOut: true, cashIn: false, scope: "corporation" },
  { code: "7520", type: "expense", normalSide: "debit", name: "為替差損", section: "営業外費用", cashOut: false, cashIn: false, scope: "common" },
  { code: "7530", type: "expense", normalSide: "debit", name: "雑損失", section: "営業外費用", cashOut: true, cashIn: false, scope: "common" },
  { code: "8010", type: "revenue", normalSide: "credit", name: "固定資産売却益", section: "特別利益", cashOut: false, cashIn: true, scope: "corporation" },
  { code: "8020", type: "expense", normalSide: "debit", name: "固定資産売却損", section: "特別損失", cashOut: false, cashIn: false, scope: "corporation" },
  { code: "8030", type: "expense", normalSide: "debit", name: "固定資産除却損", section: "特別損失", cashOut: false, cashIn: false, scope: "common" },
  { code: "8040", type: "expense", normalSide: "debit", name: "災害損失", section: "特別損失", cashOut: true, cashIn: false, scope: "common" },
  { code: "9010", type: "expense", normalSide: "debit", name: "専従者給与", section: "繰入額等", cashOut: true, cashIn: false, scope: "soleProprietor" },
  { code: "9020", type: "expense", normalSide: "debit", name: "貸倒引当金繰入", section: "繰入額等", cashOut: false, cashIn: false, scope: "common" },
  { code: "9030", type: "expense", normalSide: "debit", name: "その他引当金繰入", section: "繰入額等", cashOut: false, cashIn: false, scope: "common" },
  { code: "9040", type: "expense", normalSide: "debit", name: "青色申告特別控除", section: "繰入額等", cashOut: false, cashIn: false, scope: "soleProprietor" },
  { code: "9510", type: "expense", normalSide: "debit", name: "法人税・住民税及び事業税", section: "税金", cashOut: true, cashIn: false, scope: "corporation" },
];

function matchesBusinessType(account: Account, businessType: BusinessType) {
  return account.scope === "common" || account.scope === businessType;
}

const BY_NAME = new Map(ACCOUNTS.map((account) => [account.name, account]));
const BY_CODE = new Map(ACCOUNTS.map((account) => [account.code, account]));

/** 科目名から科目を引く。保存済みデータは名称で持っているため名称が主キー相当。 */
export function accountByName(name: string): Account | undefined {
  return BY_NAME.get(name);
}

export function accountByCode(code: string): Account | undefined {
  return BY_CODE.get(code);
}

/**
 * 未登録の科目名でも集計を止めないためのフォールバック。
 * 過去データや手入力で科目マスタに無い名称が来た場合、費用・借方として扱い
 * 「未確定勘定」相当のコードを振る。試算表で異常として可視化する。
 */
export function resolveAccount(name: string): Account {
  return (
    BY_NAME.get(name) ?? {
      code: "9999",
      type: "expense",
      normalSide: "debit",
      name,
      section: "諸口",
      cashOut: true,
      cashIn: true,
      scope: "common",
    }
  );
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
