---
name: "JavaScript 規約"
applyTo: "**/*.js"
---

# JavaScript コーディング & セキュアコーディング ガイドライン

## スタイルと慣習
---
name: "JavaScript 規約"
applyTo: "**/*.js"
---

# JavaScript コーディング & セキュアコーディング ガイドライン

このファイルは `.js` ファイルに適用されるスタイルと安全対策を
章ごとに整理したものです。実装時はこの順序に従い、必要に応じて
仕様書やチーム規約を参照してください。

## スタイルと慣習

### 1.1 用語について
- 「comment」は実装コメントを指します。/** … */ 内のテキストやアノテーションは「JSDoc」と呼びます。
- RFC 2119 の用語法（must, must not, should, should not, may）を使用します。

### 1.2 ガイドに関する注意
サンプルコードは規範的なものではありません。例はGoogle Styleで書かれていますが、唯一の正しい書き方を示すものではありません。

## 2 ソースファイルの基本

### 2.1 ファイル名
- 小文字のみ。アンダースコア（_）またはダッシュ（-）は可。
- 拡張子は `.js`。

### 2.2 ファイルエンコーディング
- UTF-8。

### 2.3 特殊文字

#### 2.3.1 空白文字
- インデントにタブは使わず、スペースのみ。
- 文字列リテラル内以外で他の空白文字は使わない。

#### 2.3.2 エスケープシーケンス
- 特殊文字は `\n`, `\t` などの名前付きエスケープを使う。
- 数値エスケープ（`\x0a`, `\u000a` など）や8進数エスケープは禁止。

#### 2.3.3 非ASCII文字
- 実際のUnicode文字または16進/Unicodeエスケープのどちらでも可。可読性を優先。
- 非表示文字や分かりにくい場合はコメントで補足する。

3 ソースファイル構成  
新しいソースファイルは、goog.module ファイル（goog.module 呼び出しを含むファイル）または ECMAScript (ES) モジュール（import/export 文を使うファイル）のいずれかでなければなりません。

ファイルは以下の順序で構成します:

- ライセンスまたは著作権情報（存在する場合）
- @fileoverview JSDoc（存在する場合）
- goog.module 文（goog.module ファイルの場合）
- ES import 文（ES モジュールの場合）
- goog.require および goog.requireType 文
- ファイル本体の実装

各セクションの間は、ファイル本体の実装以外は正確に1行の空行で区切ります。ファイル本体の実装の前は1行または2行の空行が許容されます。

3.1 ライセンスまたは著作権情報（存在する場合）  
ライセンスや著作権情報がファイルに必要な場合は、ここに記載します。

3.2 @fileoverview JSDoc（存在する場合）  
フォーマットルールは 7.5 Top/file-level comments を参照してください。

3.3 goog.module 文  
すべての goog.module ファイルは、1行で正確に1つの goog.module 名を宣言しなければなりません。goog.module 宣言を含む行は改行してはならず、80カラム制限の例外となります。

goog.module の引数全体が名前空間を定義します。これはパッケージ名（ディレクトリ構造の断片を反映した識別子）＋（オプションで）定義するメインのクラス/enum/interface 名（lowerCamelCase）です。

例:
goog.module('search.urlHistory.urlHistoryService');

3.3.1 階層構造  
モジュールの名前空間は、他のモジュールの名前空間の直接の子として命名してはいけません。

3.3.2 goog.module.declareLegacyNamespace  
goog.module 文の直後に goog.module.declareLegacyNamespace(); を記述することができますが、可能な限り使用を避けてください。

3.3.3 goog.module のエクスポート  
クラス、enum、関数、定数などは exports オブジェクトを使ってエクスポートします。エクスポートするシンボルは exports オブジェクトに直接定義するか、ローカルで宣言してから個別にエクスポートします。外部で使用するものだけをエクスポートし、モジュールローカルなシンボルは @private を付けません。エクスポートやローカルシンボルの順序は規定しません。

例:
const /** !Array<number> */ exportedArray = [1, 2, 3];
const /** !Array<number> */ moduleLocalArray = [4, 5, 6];
/** @return {number} */
function moduleLocalFunction() {
  return moduleLocalArray.length;
}
/** @return {number} */
function exportedFunction() {
  return moduleLocalFunction() * 2;
}
exports = {exportedArray, exportedFunction};
/** @const {number} */
exports.CONSTANT_ONE = 1;
/** @const {string} */
exports.CONSTANT_TWO = 'Another constant';

exports オブジェクト自体に @const を付けてはいけません（コンパイラが既に定数として扱います）。

default exports（デフォルトエクスポート）は ES モジュールとの互換性の観点から禁止です。

3.4 ES モジュール  
ES モジュールは `import`/`export` を使うファイル。

3.4.1 import 文  
- 改行してはならず、80 カラム制限の例外とする。  
- パスに必ず `.js` 拡張子を含める。  
- 同じファイルを複数回 import しない。  
- 他の ES モジュールは import し、`goog.require` してはいけない。

3.4.1.3 import 名の命名  
- **モジュール import** (`import * as name`) は、元ファイル名から導いた lowerCamelCase。  
- **名前付き import** は原則として元の名前を維持。衝突があるときは `import *` するか、エクスポート側でリネーム。どうしても変える場合はファイル名やパス要素を含める。  
- **デフォルト import** は原則禁止。非準拠モジュールを扱う場合のみファイル名由来の PascalCase/ camelCase 名を使う。


3.4.2 export
外部で使用するものだけをエクスポートし、モジュールローカルなシンボルは
@private を付けません。すべて named export を使い、default export は禁止
(名前がバラバラになりやすいため)。

export された変数はモジュール初期化以外で変更してはいけません。変更が
必要な場合はモジュールスコープでミュータブルなオブジェクトや関数を
持ち、getter／ラッパーを export する形にする。

3.4.2.1 Named export と default export
export キーワードを宣言に付与するか `export {name};` 構文を使う。
default export は NG。

3.4.2.2 export 変数のミュータビリティ
export 変数を書き換える設計は禁止。ミュータブルな状態はモジュール内に
閉じ、外部にはアクセサや関数で公開する。

3.4.2.3 export from
`export from` 文は80カラム制限の例外であり、
改行してはならない (両構文とも)。

---
name: "JavaScript 規約"
applyTo: "**/*.js"
---

# JavaScript コーディング & セキュアコーディング ガイドライン

このファイルは `.js` ファイルに適用されるスタイルと安全対策を
章ごとに整理したもの。実装時はこの順序に従い、仕様書やチーム規約を
参照する。

## 1 スタイルと慣習

- 用語：「comment」「JSDoc」など。RFC 2119 用語 must/should などを使用。
- サンプルコードは規範ではなく参考。

## 2 ソースファイルの基本

- ファイル名は小文字、アンダースコア/ダッシュ可、拡張子 `.js`。
- UTF‑8、インデントはスペースのみ。文字列内以外の特殊空白禁止。
- エスケープは `\n`, `\t` 等の名前付き。非 ASCII 文字は可読性重視。

新規ファイルは **goog.module** か **ES モジュール**。
順序は

1. ライセンス/著作権
2. `@fileoverview`
3. `goog.module`／ES import
4. `goog.require`／`goog.requireType`
5. 実装

各セクションは原則 1 行空行で区切る。

### 2.1 goog.module

- 1 行に 1 宣言、改行不可。名前空間は lowerCamelCase。
- `goog.module.declareLegacyNamespace()` は極力避ける。
- exports オブジェクトで必要なシンボルのみエクスポート。default export 禁止。

### 2.2 ES モジュール

- `import` に `.js` 拡張子を含め、改行は例外。
- 同じファイルを複数回 import しない。
- named export のみ。export 変数は初期化後変更不可。
- `export from` も 80 カラム例外。  
- **循環依存**: ECMAScript 仕様上は許可されているが
  サイクルを作成してはならない。import/export のどちらでも発生する。

### 2.3 goog.require 等

- 名前空間末尾要素をエイリアスに。行は改行禁止、順序はアルファベット。
- 副作用 require はコメント付きで単独行。
- `goog.requireType` は型注釈専用。同一名前空間に両方使わない。

## 3 フォーマット

- 波括弧常用、K&R スタイル、ブロックインデント +2 スペース。
- 空ブロックは `{}`。
- 80 カラム制限。clang‑format 推奨。
- 空行は論理的グループ化に応じて挿入。

## 4 文と構造

- 1 行に 1 文、セミコロン必須。
- `for-of` を優先。`for-in` は dict‑style オブジェクトのみ。
- 例外は `Error` またはサブクラスのみ。catch で何もしない場合は理由をコメント。
- `switch` には `default` とフォールスルーコメント。

## 5 命名規則

- 変数/関数/プロパティ: camelCase。
- クラス/型: PascalCase。
- ファイル: kebab‑case。
- 定数: CONSTANT_CASE。
- カスタムフックは `use` プレフィックス。

## 6 JSDoc

- すべてのクラス・フィールド・メソッドに JSDoc。
- タグは原則 1 行 1 つ。簡単なタグはまとめ可。
- 型注釈は `{}` で囲い、nullable は `?`、非 null は `!`。
- パラメータ/戻り値を必ず記述。テンプレート型、`@override` など適宜。

## 7 その他のルール

- `var`, `with`, `eval` 禁止。プリミティブのラッパーオブジェクト禁止。
- 自動セミコロン挿入に頼らない。
- 組み込みオブジェクトの拡張禁止。
- 生成コードは対象外。既存コードは変更量と一貫性を考慮して整形。
- 新規追加コードはガイド準拠。


3.4.4 Closureとの相互運用

3.4.4.1 goog 参照  
Closure の goog 名前空間を参照するには、Closure の goog.js を import する。

import * as goog from '../closure/goog/goog.js';

const {compute} = goog.require('a.name');

export const CONSTANT = compute();
goog.js はグローバル goog から ESモジュールで利用できるプロパティのみをエクスポートする。

3.4.4.2 ESモジュールでの goog.require  
ESモジュール内での goog.require は goog.module ファイルと同様に動作する。goog.provide や goog.module で作成された Closure 名前空間シンボルを require でき、goog.require はその値を返す。

import * as goog from '../closure/goog/goog.js';
import * as anEsModule from './anEsModule.js';

const GoogPromise = goog.require('goog.Promise');
const myNamespace = goog.require('my.namespace');

3.4.4.3 ESモジュールでの Closure Module ID 宣言  
goog.declareModuleId を ESモジュール内で使うことで、goog.module 風の module ID を宣言できる。これにより、その module ID は goog.require や goog.module.get で参照できる。グローバルな JavaScript シンボルとしては作成されない。

goog.require（または goog.module.get）で goog.declareModuleId で宣言した module ID を参照すると、常にモジュールオブジェクト（import * と同様）が返る。そのため、goog.declareModuleId の引数は lowerCamelCase で終わるべき。

注意: ESモジュール内で goog.module.declareLegacyNamespace を呼ぶのはエラー。これは goog.module ファイルでのみ使用可能。ESモジュールとレガシー名前空間を直接関連付ける方法はない。

goog.declareModuleId は Closure ファイルを段階的に ESモジュールへ移行する際にのみ使用すること。

import * as goog from '../closure/goog.js';

goog.declareModuleId('my.esm');

export class Class {};

3.5 goog.setTestOnly  
goog.module ファイルでは goog.module 文や（存在する場合）goog.module.declareLegacyNamespace() 文の直後に goog.setTestOnly() を記述できる。

ESモジュールでは import 文の直後に goog.setTestOnly() を記述できる。

3.6 goog.require / goog.requireType 文  
依存関係の import は goog.require および goog.requireType 文で行う。goog.require で import した名前はコードと型アノテーションの両方で使えるが、goog.requireType は型アノテーション専用。

goog.require / goog.requireType 文は空行なしで連続したブロックを形成し、goog.module 宣言の直後に1行空けて配置する。ファイル内の他の場所で使ってはならない。

goog.require の左辺に単一の定数エイリアスを割り当てる場合、import 先の名前空間の最後の要素と一致させること。

例外: 名前の衝突回避や可読性向上のため、名前空間の追加要素を含めた長いエイリアスを使ってもよい。ネイティブ型（Element, Event, Error, Map, Promise など）と衝突する場合は必ず長いエイリアスを使う。

分割代入でエイリアスをリネームする場合、コロンの後にスペースを入れる（4.6.2参照）。

同じ名前空間に対して goog.require と goog.requireType を両方使ってはならない。両方必要な場合は goog.require のみを使う。

副作用目的でのみ import する場合は goog.require を使い、代入は省略できる。その際はコメントで理由を説明し、コンパイラ警告を抑制する。

行の並び順:  
1. 左辺に名前がある require（アルファベット順）  
2. 分割代入の require（左辺名でソート）  
3. 副作用のみの require（単独行）

長いエイリアスやモジュール名で80カラムを超える場合でも、require 行は改行してはならない。

例:

// 標準的なエイリアス
const asserts = goog.require('goog.asserts');
// 名前空間ベースのエイリアス（衝突回避）
const testingAsserts = goog.require('goog.testing.asserts');
// 分割代入
const {MyClass} = goog.require('some.package');
const {MyType} = goog.requireType('other.package');
const {clear, clone} = goog.require('goog.array');
const {Rgb} = goog.require('goog.color');
// 名前空間ベースの分割代入（衝突回避）
const {MyClass: NsMyClass} = goog.require('other.ns');
const {SomeType: FooSomeType} = goog.requireType('foo.types');
const {clear: objectClear, clone: objectClone} = goog.require('goog.object');
// ネイティブ型との衝突回避
const {Element: RendererElement} = goog.require('web.renderer');
// 可読性向上のための長いエイリアス
const {SomeDataStructure: SomeDataStructureModel} = goog.requireType('identical.package.identifiers.models');
const {SomeDataStructure: SomeDataStructureProto} = goog.require('proto.identical.package.identifiers');
// 副作用目的の require
/** @suppress {extraRequire} Initializes MyFramework. */
goog.require('my.framework.initialization');

非推奨:

// レガシーな default export スタイルは新規コードで禁止
const MyClass = goog.require('some.package.MyClass');
const MyType = goog.requireType('some.package.MyType');
// 必要なら PackageClass のようなエイリアスを使う

禁止:

// 名前空間外のエイリアス
const MyClassForBizzing = goog.require('some.package.MyClass');
// エイリアスは必ず名前空間の最後の要素
const MyClass = goog.require('some.package.MyClassForBizzing');
// ネイティブ型をマスクしてはならない（例: Map）
const Map = goog.require('jspb.Map');
// require 行の改行禁止
const SomeDataStructure =
  goog.require('proto.identical.package.identifiers.SomeDataStructure');
// 名前空間ベースでないエイリアス
const randomName = goog.require('something.else');
// コロンの後にスペースがない
const {Foo:FooProto} = goog.require('some.package.proto.Foo');
// goog.requireType にエイリアスがない
goog.requireType('some.package.with.a.Type');

/**
 * @param {!some.unimported.Dependency} param
 *     JSDoc で使う外部型は必ず goog.require で import すること（externs で宣言されている場合を除く）
 */
function someFunction(param) {
  // goog.require はトップレベルでのみ使用可
  const alias = goog.require('my.long.name.alias');
  // ...
}

3.7 ファイル本体の実装  
すべての依存関係宣言の後（少なくとも1行空けて）、実装を記述する。

ここにはモジュールローカルの定数、変数、クラス、関数、エクスポートするシンボルなどを含めてよい。

4 フォーマット  
用語: block-like construct とは、クラス・関数・メソッド・波括弧で囲まれたブロックの本体を指す。5.2, 5.3 の通り、配列リテラルやオブジェクトリテラルも block-like construct として扱ってよい。

Tip: clang-format を使うこと。JavaScript コミュニティは clang-format が正しいフォーマットを行うよう努力している。主要なエディタとの連携もある。

4.1 波括弧  
4.1.1 すべての制御構造で波括弧を使う  
if, else, for, do, while など、すべての制御構造で波括弧を必須とする。ブロックが1文のみでも省略不可。非空ブロックの最初の文は必ず新しい行で始める。

禁止例:

if (someVeryLongCondition())
  doSomething();

for (let i = 0; i < foo.length; i++) bar(foo[i]);

例外: 1行で収まり、else を持たない単純な if 文のみ波括弧省略可。

if (shortCondition()) foo();

4.1.2 非空ブロック: K&Rスタイル  
非空ブロックや block-like construct の波括弧は K&R スタイル（エジプシャン・ブラケット）で記述する：

- 開き波括弧の前に改行しない
- 開き波括弧の後に改行
- 閉じ波括弧の前に改行
- 閉じ波括弧の後、もしそれが文や関数・クラス・メソッド本体を終端する場合は改行。else, catch, while, カンマ, セミコロン, 括弧で続く場合は改行しない

例:

class InnerClass {
  constructor() {}

  /** @param {number} foo */
  method(foo) {
  if (condition(foo)) {
    try {
    // Note: this might fail.
    something();
    } catch (err) {
    recover();
    }
  }
  }
}

4.1.3 空ブロック: 簡潔に書いてよい  
空ブロックや block-like construct は、開き波括弧の直後に何も書かずすぐ閉じてよい（{}）。ただし、if/else や try/catch/finally のような複数ブロックを直接含む場合は除く。

例:

function doNothing() {}

禁止例:

if (condition) {
  // …
} else if (otherCondition) {} else {
  // …
}

try {
  // …
} catch (e) {}
4.2 ブロックインデント: +2スペース
新しいブロックや block-like construct が開かれるたびに、インデントは2スペース増やします。ブロックが終了すると、インデントは元のレベルに戻ります。インデントレベルは、ブロック内のコードとコメントの両方に適用されます。（4.1.2 Nonempty blocks: K&R style の例を参照）

4.2.1 配列リテラル: 任意でブロック風
任意の配列リテラルは「block-like construct」としてフォーマットしても構いません。例えば、以下はすべて有効です（抜粋例）:

const a = [
  0,
  1,
  2,
];

const b =
    [0, 1, 2];
const c = [0, 1, 2];

someMethod(foo, [
  0, 1, 2,
], bar);
他にも、要素間の意味的なグループ化を強調する場合など、さまざまな組み合わせが許容されますが、単に縦幅を減らす目的だけで使うべきではありません。

4.2.2 オブジェクトリテラル: 任意でブロック風
任意のオブジェクトリテラルも「block-like construct」としてフォーマット可能です。4.2.1 配列リテラルと同様の例が適用されます。

const a = {
  a: 0,
  b: 1,
};

const b =
    {a: 0, b: 1};
const c = {a: 0, b: 1};

someMethod(foo, {
  a: 0, b: 1,
}, bar);
4.2.3 クラスリテラル
クラスリテラル（宣言・式）はブロックとしてインデントします。メソッドやクラス宣言の閉じ波括弧の後にセミコロンは付けません（ただし、クラス式を含む代入文などはセミコロンで終わります）。継承には extends キーワードのみで十分ですが、スーパークラスがジェネリクスの場合は @extends JSDoc を明示します。

例:

/** @template T */
class Foo {
  /** @param {T} x */
  constructor(x) {
    /** @type {T} */
    this.x = x;
  }
}

/** @extends {Foo<number>} */
class Bar extends Foo {
  constructor() {
    super(42);
  }
}

exports.Baz = class extends Bar {
  /** @return {number} */
  method() {
    return this.x;
  }
};
/** @extends {Bar} */ // <-- 不要な @extends
exports.Baz = class extends Bar {
  /** @return {number} */
  method() {
    return this.x;
  }
};
4.2.4 無名関数式
関数呼び出しの引数リスト内で無名関数を宣言する場合、関数本体は直前のインデント深さより+2スペースでインデントします。

例:

prefix.something.reallyLongFunctionName('whatever', (a1, a2) => {
  // 'prefix' のインデントより+2
  if (a1.equals(a2)) {
    someOtherLongFunctionName(a1);
  } else {
    andNowForSomethingCompletelyDifferent(a2.parrot);
  }
});

some.reallyLongFunctionCall(arg1, arg2, arg3)
    .thatsWrapped()
    .then((result) => {
      // '.then()' のインデントより+2
      if (result) {
        result.use();
      }
    });
4.2.5 switch文
他のブロックと同様、switchブロックの内容も+2でインデントします。

switchラベルの後は改行し、インデントレベルを+2します。明示的なブロックが必要な場合は使用可能です。次のswitchラベルでインデントを戻します。

breakの後に空行を入れるかは任意です。

例:

switch (animal) {
  case Animal.BANDERSNATCH:
    handleBandersnatch();
    break;

  case Animal.JABBERWOCK:
    handleJabberwock();
    break;

  default:
    throw new Error('Unknown animal');
}
4.3 文（Statements）
4.3.1 1行に1文
各文は改行で区切ります。

4.3.2 セミコロン必須
すべての文はセミコロンで終わらせます。自動セミコロン挿入（ASI）に頼るのは禁止です。

4.4 カラム制限: 80
JavaScriptコードは80カラム制限です。下記例外を除き、これを超える場合は4.5 Line-wrappingに従い折り返します。

例外:

- goog.module, goog.require, goog.requireType 文（3.3, 3.6参照）
- ES module import/export from 文（3.4.1, 3.4.2.3参照）
- クリック可能な長いURL
- コピペ用のシェルコマンド
- 検索やコピペが必要な長い文字列リテラル

4.5 ラインラップ（折り返し）
用語: ラインラップとは、カラム制限を守るためにコードを複数行に分割することです。

すべてのケースに当てはまる厳密なルールはありません。複数の妥当な折り返し方が存在します。

注: 通常はカラム制限回避のためですが、制限内でも著者の裁量で折り返して構いません。

Tip: メソッドやローカル変数に抽出することで、折り返しを避けられる場合もあります。

4.5.1 折り返し位置
折り返しの最優先は「より高い構文レベルで折る」ことです。

推奨:

currentEstimate =
    calc(currentEstimate + x * currentEstimate) /
        2.0;
非推奨:

currentEstimate = calc(currentEstimate + x *
    currentEstimate) / 2.0;
上記例での構文レベル（高→低）は: 代入、除算、関数呼び出し、引数、定数。

演算子で折り返す場合は、演算子の後で改行します（ただし . は除く）。
メソッドやコンストラクタ名は直後の ( と同じ行にします。
カンマは直前のトークンと同じ行にします。
return の後で改行しない（意味が変わるため）。
JSDoc型注釈は { の後で折り返します。
注: 折り返しの主目的は「明瞭なコード」であり、最小行数ではありません。

4.5.2 継続行は+4スペース以上
折り返した2行目以降（継続行）は、元の行より少なくとも+4スペースでインデントします（ただしブロックインデント規則が優先される場合を除く）。

複数の継続行がある場合、より深い構文レベルほど大きなインデントを使い、同じレベルの要素は同じインデントにします。

4.6.3 横方向のアラインメント: 非推奨 で水平方向の揃えについて述べています。

4.6 空白
4.6.1 垂直方向の空白（改行）
1行の空白行を入れる場面:

- クラスやオブジェクトリテラル内の連続するメソッド間
  - 例外: オブジェクトリテラル内の連続するプロパティ間は任意
- メソッド本体内で論理的なグループ化が必要な場合（関数本体の先頭・末尾は不可）
- クラスやオブジェクトリテラルの最初・最後（任意）
- 他の規則で要求される場合（例: 3.6 goog.require など）
複数の連続した空行は許可されますが、必須でも推奨でもありません。

4.6.2 横方向の空白
空白の使い方は場所によって異なり、主に先頭（インデント）、末尾、内部の3種類です。インデントは他で述べているので省略。末尾の空白は禁止。

内部空白（ASCIIスペース）は以下の場合のみ:

- 予約語（if, for, catch など）と直後の ( の間（function, super は除く）
- else, catch などと直前の } の間
- 開き波括弧 { の前（ただし、関数の第1引数や配列の第1要素がオブジェクトリテラルの場合、テンプレート展開内は除く）
- 2項・3項演算子の両側
- カンマ・セミコロンの後（直前は不可）
- オブジェクトリテラルのコロン : の後
- 行末コメント // の両側（複数スペースも可）
- ブロックコメントの開始直後・終了直前（型キャストや引数名コメントなど）

4.6.3 横方向のアラインメント: 非推奨
水平方向のアラインメント（スペース数を調整して縦を揃える）は許可されますが、Google Styleでは推奨されません。既存のアラインメントを維持する必要もありません。

例（どちらも可、下は非推奨）:

{
  tiny: 42, // good
  longer: 435, // good
};

{
  tiny:   42,  // 許可されるが、編集時に崩れる
  longer: 435,
};
Tip: アラインメントは可読性向上に役立つ場合もありますが、将来の編集で無駄な修正や履歴汚染、マージ衝突を招きやすいです。

4.6.4 関数引数
関数名と引数は同じ行に書くのが基本です。80カラムを超える場合は、可読性の高い方法で折り返します。スペース節約のためにできるだけ詰めて折り返しても、各引数を1行ずつにしても構いません。インデントは4スペース。括弧に揃えるのも可ですが非推奨。

例:

// 引数が2行目から始まる（推奨）
doSomething(
    descriptiveArgumentOne, descriptiveArgumentTwo, descriptiveArgumentThree) {
  // …
}

// 長い場合は80カラムで折り返し（非推奨）
doSomething(veryDescriptiveArgumentNumberOne, veryDescriptiveArgumentTwo,
    tableModelEventHandlerProxy, artichokeDescriptorAdapterIterator) {
  // …
}

// 1引数1行（長い関数名や強調したい場合）
doSomething(
    veryDescriptiveArgumentNumberOne,
    veryDescriptiveArgumentTwo,
    tableModelEventHandlerProxy,
    artichokeDescriptorAdapterIterator) {
  // …
}
4.7 括弧のグルーピング: 推奨
省略可能な括弧は、著者とレビュアーが「誤解の余地がない」と合意できる場合のみ省略します。すべての読者が演算子の優先順位を暗記しているとは限りません。

delete, typeof, void, return, throw, case, in, of, yield の直後に全体を括る不要な括弧は使いません。

型キャスト（/** @type {!Foo} */ (foo)）には括弧が必須です。

4.8 コメント
このセクションは実装コメントについて述べます（JSDocは7章）。

4.8.1 ブロックコメントスタイル
ブロックコメントは周囲のコードと同じインデントにします。/* … */ または // スタイルが使えます。複数行の /* … */ コメントでは、2行目以降の * を1行目と揃えます。

/*
 * This is
 * okay.
 */

// And so
// is this.

/* This is fine, too. */
コメントをアスタリスクや他の文字で囲ったボックスにはしません。

実装コメントに JSDoc（/** … */）は使いません。

4.8.2 引数名コメント
値やメソッド名だけでは意味が伝わらない場合、「引数名コメント」を使います。推奨フォーマットは値の前に /* name= */:

someFunction(obviousParam, /* shouldRender= */ true, /* name= */ 'hello');
周囲のコードに合わせて値の後ろに /* name */ と書いても構いません。

someFunction(obviousParam, true /* shouldRender */, 'hello' /* name */);
5 言語機能
JavaScriptには危険な機能も多く含まれます。このセクションでは使用可否や追加制約を示します。

本スタイルガイドで言及されていない言語機能は、特に推奨・非推奨なく使用可能です。

5.1 ローカル変数宣言
5.1.1 const と let を使う  
すべてのローカル変数は const または let で宣言してください。デフォルトは const を使い、再代入が必要な場合のみ let を使います。var キーワードは使用禁止です。

5.1.2 1宣言につき1変数  
ローカル変数の宣言は1行につき1つだけにしてください。let a = 1, b = 2; のような複数同時宣言は禁止です。

5.1.3 必要なときに宣言し、できるだけ早く初期化  
ローカル変数は、ブロックや関数の先頭でまとめて宣言するのではなく、使う直前（合理的な範囲で）に宣言し、できるだけ早く初期化してください。スコープを最小限に抑えます。

5.1.4 型は必要に応じて明示  
JSDoc 型アノテーションは、宣言の直前の行、または他にJSDocがなければ変数名の直前にインラインで記述できます。

例:

const /** !Array<number> */ data = [];

/**
 * Some description.
 * @type {!Array<number>}
 */
const data = [];
インラインとJSDocの併用は禁止です。コンパイラは最初のJSDocしか処理しないため、インライン型は無視されます。

/** Some description. */
const /** !Array<number> */ data = [];
Tip: 空配列や空オブジェクト、Map/Setなどテンプレート型パラメータが推論できない場合や、クロージャで変数が変更される場合は、型アノテーションが特に有効です。型パラメータが unknown になるのを防げます。

5.2 配列リテラル
5.2.1 トレーリングカンマを使う  
要素の最後と閉じカッコの間に改行がある場合は、必ず末尾にカンマを付けてください。

例:

const values = [
  'first value',
  'second value',
];
5.2.2 可変長 Array コンストラクタ禁止  
Array コンストラクタは引数の数によって挙動が変わるため危険です。リテラルを使ってください。

禁止例:

const a1 = new Array(x1, x2, x3);
const a2 = new Array(x1, x2);
const a3 = new Array(x1);
const a4 = new Array();
a3 の場合、x1 が整数ならその長さの空配列、他は例外や1要素配列になるなど予測困難です。

代わりに以下のように書きます:

const a1 = [x1, x2, x3];
const a2 = [x1, x2];
const a3 = [x1];
const a4 = [];
長さ指定で new Array(length) を使うのは許可されます。

5.2.3 非数値プロパティ禁止  
配列に length 以外の非数値プロパティを定義・使用しないでください。必要なら Map や Object を使います。

5.2.4 分割代入 (Destructuring)  
配列リテラルは左辺で分割代入に使えます。末尾に ...rest も可（...と変数名の間はスペースなし）。未使用要素は省略します。

const [a, b, c, ...rest] = generateResults();
let [, b,, d] = someArray;
関数パラメータにも使えます。省略可能な場合は必ず [] をデフォルト値にし、左辺でデフォルト値を指定してください。

/** @param {!Array<number>=} param1 */
function optionalDestructuring([a = 4, b = 2] = []) { … };
禁止例:

function badDestructuring([a, b] = [4, 2]) { … };
Tip: 複数値の受け渡しには、できるだけオブジェクト分割代入を使い、各要素に名前と型を付けることを推奨します。

5.2.5 スプレッド演算子  
配列リテラル内で ... を使って他の iterable を展開できます。Array.prototype の冗長な書き方よりスプレッドを推奨します。...の後にスペースは入れません。

例:

[...foo]   // Array.prototype.slice.call(foo) より推奨
[...foo, ...bar]   // foo.concat(bar) より推奨
5.3 オブジェクトリテラル
5.3.1 トレーリングカンマを使う  
プロパティの最後と閉じカッコの間に改行がある場合は、必ず末尾にカンマを付けてください。

5.3.2 Object コンストラクタ禁止  
Object コンストラクタ（new Object()）は使わず、{} または {a: 0, b: 1} のようなリテラルを使ってください。

5.3.3 クォート有無のキー混在禁止  
オブジェクトリテラルは struct（非クォート/シンボルキー）か dict（クォート/計算キー）のどちらかに統一し、混在させないでください。

禁止例:

{
  width: 42, // struct-style
  'maxWidth': 43, // dict-style
}
hasOwnProperty などでプロパティ名を文字列で渡すのも禁止です。コンパイル時に壊れる可能性があります。

禁止例:

/** @type {{width: number, maxWidth: (number|undefined)}} */
const o = {width: 42};
if (o.hasOwnProperty('maxWidth')) {
  ...
}
正しい例:

/** @type {{width: number, maxWidth: (number|undefined)}} */
const o = {width: 42};
if (o.maxWidth != null) {
  ...
}
5.3.4 計算プロパティ名  
計算プロパティ名（例: {['key' + foo()]: 42}）は許可されますが、これは dict-style（クォートキー）扱いです。シンボルの場合のみ struct-style として混在可。enum値も計算キーに使えますが、非enumキーと混在させないでください。

5.3.5 メソッド短縮記法  
オブジェクトリテラル内のメソッドは、コロン＋関数リテラルの代わりに method() { ... } の短縮記法を使えます。

例:

return {
  stuff: 'candy',
  method() {
    return this.stuff;  // 'candy' を返す
  },
};
このとき、this はオブジェクト自身を指します。アロー関数の場合は外側のスコープの this になります。

例:

class {
  getObjectLiteral() {
    this.stuff = 'fruit';
    return {
      stuff: 'candy',
      method: () => this.stuff,  // 'fruit' を返す
    };
  }
}
5.3.6 プロパティ短縮記法  
オブジェクトリテラルで {foo, bar} のような短縮プロパティ記法を使えます。

例:

const foo = 1;
const bar = 2;
const obj = {
  foo,
  bar,
  method() { return this.foo + this.bar; },
};
assertEquals(3, obj.method());
5.3.7 分割代入 (Destructuring)  
オブジェクト分割代入は左辺で使えます。関数パラメータにも使えますが、1階層の非クォート短縮プロパティのみ許可です。ネストや計算キーは不可。デフォルト値は左辺で指定し、オプショナルな場合は {} をデフォルトにしてください。JSDoc のパラメータ名は任意ですが必須です。

例:

/**
 * @param {string} ordinary
 * @param {{num: (number|undefined), str: (string|undefined)}=} param1
 *     num: The number of times to do something.
 *     str: A string to do stuff to.
 */
function destructured(ordinary, {num, str = 'some default'} = {}) {}
禁止例:

/** @param {{x: {num: (number|undefined), str: (string|undefined)}}} param1 */
function nestedTooDeeply({x: {num, str}}) {};
/** @param {{num: (number|undefined), str: (string|undefined)}=} param1 */
function nonShorthandProperty({num: a, str: b} = {}) {};
/** @param {{a: number, b: number}} param1 */
function computedKey({a, b, [a + b]: c}) {};
/** @param {{a: number, b: string}=} param1 */
function nontrivialDefault({a, b} = {a: 2, b: 4}) {};
goog.require の分割代入も許可されますが、必ず1行で記述してください。

5.3.8 Enum
列挙型は @enum アノテーション付きのオブジェクトリテラルで定義します。enum はモジュールローカルまたは exports 直下に定義し、型やオブジェクトの下にネストしないでください。

定義後にプロパティ追加は禁止。enum は定数でなければなりません。値は文字列リテラルまたは数値のみ。

/**
 * Supported temperature scales.
 * @enum {string}
 */
const TemperatureScale = {
  CELSIUS: 'celsius',
  FAHRENHEIT: 'fahrenheit',
};

/**
 * An enum with two values.
 * @enum {number}
 */
const Value = {
  /** The value used shall have been the first. */
  FIRST_VALUE: 1,
  /** The second among two values. */
  SECOND_VALUE: 2,
};
文字列 enum の値は静的なリテラルのみ許可。計算式・テンプレート・関数・変数参照は禁止。

const ABSOLUTE_ZERO = '-273°F';

/**
 * Not supported computed values in string enum.
 * @enum {string}
 */
const TemperatureInFahrenheit = {
  MIN_POSSIBLE: ABSOLUTE_ZERO,
  ZERO_FAHRENHEIT: 0 + '°F',
  ONE_FAHRENHEIT: `${Values.FIRST_VALUE}°F`,
  TWO_FAHRENHEIT: Values.SECOND_VALUE + '°F',
  SOME_FAHRENHEIT: getTemperatureInFahrenheit() + '°F',
};
Note: TypeScript ではより多様な enum 値が許可されますが、本ガイドでは移行性のためリテラルと数値のみ許可です。複雑な値は @enum なしの const オブジェクトを使ってください。

5.4 クラス
5.4.1 コンストラクタ  
コンストラクタは省略可能です。サブクラスのコンストラクタは、this にアクセスする前に必ず super() を呼んでください。インターフェースは非メソッドプロパティを constructor で宣言します。

5.4.2 フィールド  
具象オブジェクトのすべてのフィールド（メソッド以外のプロパティ）は constructor 内で定義してください。再代入しないフィールドには @const を付けます（deep immutable でなくても可）。非公開フィールドには適切な可視性アノテーション（@private, @protected, @package）を付けます。@private フィールド名は末尾に _ を付けてもよいです。フィールドは constructor のネストスコープや prototype で定義しないでください。

例:

class Foo {
  constructor() {
    /** @private @const {!Bar} */
    this.bar_ = computeBar();

    /** @protected @const {!Baz} */
    this.baz = computeBaz();
  }
}
Tip: コンストラクタ終了後にプロパティを追加・削除しないでください。VM の最適化が阻害されます。後で初期化する場合も undefined で明示的に初期化してください。@struct を付けると未宣言プロパティの追加・アクセスをチェックできます。クラスはデフォルトで @struct です。

5.4.3 計算プロパティ  
クラスで計算プロパティを使う場合は、プロパティがシンボルのときのみ許可です。dict-style（クォートや計算キー）は禁止。反復可能なクラスには [Symbol.iterator] を定義してください。その他の Symbol は慎重に使ってください。

Tip: Symbol.isConcatSpreadable など一部のビルトイン Symbol はコンパイラでポリフィルされないため、古いブラウザでは動作しません。

5.4.4 静的メソッド  
可読性を損なわない範囲で、private static メソッドよりもモジュールローカル関数を優先してください。

静的メソッドの動的ディスパッチには依存しないでください。静的メソッドはベースクラス自身でのみ呼び出してください。サブクラスで未定義の静的メソッドを直接呼ぶのは禁止です（@nocollapse が必要な場合も）。static メソッド内で this を使うのは禁止です。

禁止例:

// 以下は文脈例。単体では許可されるコードです。
class Base {
  /** @nocollapse */ static foo() {}
}
class Sub extends Base {}

// discouraged: 静的メソッドの動的呼び出し
function callFoo(cls) { cls.foo(); }

// 禁止: サブクラスで未定義の静的メソッドを直接呼ぶ
Sub.foo();

// 禁止: static メソッド内で this を使う
class Clazz {
  static foo() {
    return this.staticField;
  }
}
Class.staticField = 1;
5.4.5 旧式クラス宣言  
ES6 クラスが推奨ですが、ES6 クラス構文が使えない場合（既存のサブクラスやフレームワークの都合など）は旧式構文も許可されます。

goog.defineClass を使うと ES6 クラスに近い定義ができます。

let C = goog.defineClass(S, {
  /**
   * @param {string} value
   */
  constructor(value) {
    S.call(this, 2);
    /** @const */
    this.prop = value;
  },

  /**
   * @param {string} param
   * @return {number}
   */
  method(param) {
    return 0;
  },
});
または、より伝統的な構文も許可されます。

/**
  * @constructor @extends {S}
  * @param {string} value
  */
function C(value) {
  S.call(this, 2);
  /** @const */
  this.prop = value;
}
goog.inherits(C, S);

/**
 * @param {string} param
 * @return {number}
 */
C.prototype.method = function(param) {
  return 0;
};
インスタンスプロパティは、スーパークラスの constructor 呼び出し後に定義してください。メソッドは prototype に定義します。

プロトタイプ階層の構築は難しいので、goog.inherits の利用を推奨します。

5.4.6 プロトタイプの直接操作禁止  
class キーワードを使うことで、prototype プロパティを直接操作するよりも明確で可読性の高いクラス定義ができます。通常の実装コードで prototype を直接操作しないでください（5.4.5 旧式クラス宣言は例外）。ミックスインやビルトインオブジェクトのプロトタイプ変更は禁止です。

例外: フレームワーク（Polymer, Angular など）で必要な場合は許可します。

5.4.7 Getter/Setter の禁止  
JavaScript の getter/setter プロパティは予測困難で、コンパイラのサポートも限定的なため使用禁止です。通常は普通のメソッドを提供してください。

例外: データバインディングフレームワーク（Angular, Polymer など）や外部API互換のため必要な場合のみ、get/set 短縮記法または Object.defineProperties（Object.defineProperty はリネームに干渉するので不可）で定義可。getter は副作用を持たせてはいけません。

禁止例:

class Foo {
  get next() { return this.nextId++; }
}
5.4.8 toString のオーバーライド  
toString メソッドはオーバーライドしてもよいですが、常に成功し、目に見える副作用を持たないようにしてください。

Tip: toString 内で他のメソッドを呼ぶ場合、例外条件で無限ループになる可能性があるので注意してください。

5.4.9 インターフェース  
インターフェースは @interface または @record で宣言できます。@record で宣言したインターフェースは、クラスやオブジェクトリテラルによって明示的（@implements 経由）または暗黙的に実装できます。

インターフェース上のすべてのメソッドは static であってはならず、メソッド本体は空ブロックでなければなりません。フィールドはクラスの constructor 内で初期化されていないメンバーとして宣言します。

例:

/**
 * Something that can frobnicate.
 * @record
 */
class Frobnicator {
  constructor() {
    /** @type {number} The number of attempts before giving up. */
    this.attempts;
  }

  /**
   * Performs the frobnication according to the given strategy.
   * @param {!FrobnicationStrategy} strategy
   */
  frobnicate(strategy) {}
}

5.4.10 抽象クラス  
必要に応じて抽象クラスを使用してください。抽象クラスや抽象メソッドには必ず @abstract を付与します。goog.abstractMethod は使用しません。詳細は「抽象クラスとメソッド」を参照してください。

5.4.11 静的コンテナクラスを作らない  
名前空間化のためだけに、static メソッドやプロパティのみを持つコンテナクラスを作成しないでください。

// container.js
// NG例: static メソッドとフィールドのみのクラス
class Container {
  /** @return {number} */
  static bar() {
    return 1;
  }
}

/** @const {number} */
Container.FOO = 1;

exports = {Container};

代わりに、個々の定数や関数を直接 export してください:

/** @return {number} */
exports.bar = () => {
  return 1;
}

/** @const {number} */
exports.FOO = 1;

5.4.12 ネストした名前空間を定義しない  
他のモジュールローカル名の上に型（クラス、typedef、enum、interface など）をネストして定義しないでください。

// foo.js
goog.module('my.namespace');

class Foo {...}

Foo.Bar = class {...};

/** @enum {number} */
Foo.Baz = {...};

/** @typedef {{value: number}} */
Foo.Qux;

/** @interface */
Foo.Quuz = class {...}

exports.Foo = Foo;

これらの値はトップレベルで export してください。明確な名前を付けて export します（例: FooConverter など）。ただし、モジュール名がクラス名の一部と重複する場合は冗長性を避けてください（foo.Foo, foo.Converter など）。import 側で必要に応じてエイリアスを付けてください（例: import {Converter as FooConverter} from './foo';）。

// foo.js
goog.module('my.namespace');

class Foo {...}

class FooBar {...}

/** @enum {string} */
let FooBaz = {...};

/** @typedef {{value: number}} */
let FooQux;

/** @interface */
class FooQuuz {...};

export = {
  Foo,
  FooBar,
  FooBaz,
  FooQux,
  FooQuuz,
};

5.5 関数

5.5.1 トップレベル関数  
トップレベル関数は exports オブジェクトに直接定義するか、ローカルで宣言してから export できます。詳細は 3.3.3 goog.module Exports を参照してください。

例:

/** @param {string} str */
exports.processString = (str) => {
  // 文字列を処理する
};
/** @param {string} str */
const processString = (str) => {
  // 文字列を処理する
};

exports = {processString};

5.5.2 ネスト関数とクロージャ  
関数内でネストした関数定義が可能です。名前を付けるのが有用な場合は、ローカル const に代入してください。

5.5.3 アロー関数  
アロー関数は簡潔な構文を提供し、this のスコープも簡単になります。ネストした関数には function キーワードよりアロー関数を推奨します（ただし 5.3.5 Method shorthand 参照）。

this のスコープを調整するための f.bind(this), goog.bind(f, this), const self = this などよりもアロー関数を優先してください。コールバックでパラメータを明示的に渡したい場合にも便利です。

アローの左側は0個以上のパラメータです。パラメータが1つだけで分割代入でなければ括弧は省略できますが、常に括弧を使うと将来の変更で安全です。

右側は関数本体です。デフォルトはブロック（{}）ですが、単一式の場合は式のみで return 省略可です。値を返す必要がない場合や副作用のみの場合は void を使って明示してください。短い式の場合は単一式構文を推奨します。

例:

/**
 * アロー関数も通常の関数同様にドキュメント化できます。
 * @param {number} numParam
 * @param {string} strParam
 * @return {number}
 */
const moduleLocalFunc = (numParam, strParam) => numParam + Number(strParam);

// 単一式で値を返さない場合は void を使う
getValue((result) => void alert(`Got ${result}`));

class CallbackExample {
  constructor() {
    /** @private {number} */
    this.cachedValue_ = 0;

    // インラインコールバックでの型注釈例
    getNullableValue((/** ?number */ result) => {
      this.cachedValue_ = result == null ? 0 : result;
    });
  }
}

NG例:

/**
 * パラメータなし・戻り値なしの関数。
 * 単一式本体だが、void を付けていないのでNG。
 */
const moduleLocalFunc = () => anotherFunction();

5.5.4 ジェネレータ  
ジェネレータは必要に応じて使用できます。

generator 関数を定義する際は function キーワードに * を付け、関数名とはスペースで区切ります。yield* のような delegating yield も同様です。

例:

/** @return {!Iterator<number>} */
function* gen1() {
  yield 42;
}

/** @return {!Iterator<number>} */
const gen2 = function*() {
  yield* gen1();
}

class SomeClass {
  /** @return {!Iterator<number>} */
  * gen() {
    yield 42;
  }
}

5.5.5 パラメータと戻り値の型  
関数のパラメータや戻り値の型は JSDoc で記述してください。詳細は 7.8 Method and function comments を参照。

5.5.5.1 デフォルトパラメータ  
オプションのパラメータはパラメータリスト内で = を使って指定できます。オプションパラメータには必ず両側にスペースを入れ、名前は通常のパラメータと同じ（opt_ などは付けない）、JSDoc では = を付け、必ず必須パラメータの後ろに書きます。副作用のある初期値は避けてください。具象関数のすべてのオプションパラメータにはデフォルト値が必要です（undefined でも可）。抽象・インターフェースメソッドではデフォルト値を省略します。

例:

/**
 * @param {string} required 必須パラメータ
 * @param {string=} optional オプションパラメータ
 * @param {!Node=} node もう一つのオプション
 */
function maybeDoSomething(required, optional = '', node = undefined) {}

/** @interface */
class MyInterface {
  /**
   * インターフェースや抽象メソッドではデフォルト値を省略
   * @param {string=} optional
   */
  someMethod(optional) {}
}

デフォルトパラメータは多用せず、オプションが多い場合は分割代入を推奨します。

Note: Python と異なり、{} や [] などの新しいオブジェクトをデフォルト値にしても毎回新しく生成されるため安全です。

Tip: 初期値に関数呼び出しなど任意の式を使えますが、できるだけ単純にしてください。

5.5.5.2 レストパラメータ  
arguments を使わず、レストパラメータ（...）を使ってください。JSDoc では ...型名 で記述します。レストパラメータはリストの最後にのみ記述し、...の後にスペースは入れません。var_args や arguments という名前は使わないでください。

例:

/**
 * @param {!Array<string>} array
 * @param {...number} numbers
 */
function variadic(array, ...numbers) {}

5.5.6 ジェネリクス  
必要に応じて @template TYPE でジェネリック関数やメソッドを宣言してください。

5.5.7 スプレッド演算子  
関数呼び出し時にスプレッド演算子（...）を使えます。配列や iterable を複数パラメータに展開する場合は Function.prototype.apply よりスプレッドを推奨します。...の後にスペースは入れません。

例:

function myFunction(...elements) {}
myFunction(...array, ...iterable, ...generator());
5.6 文字列リテラル
5.6.1 シングルクォートを使う
通常の文字列リテラルはシングルクォート（'）で囲みます。ダブルクォート（"）は使いません。

Tip: 文字列内にシングルクォートが含まれる場合は、エスケープを避けるためテンプレートリテラル（`）の利用を検討してください。

通常の文字列リテラルは複数行にまたがってはいけません。

5.6.2 テンプレートリテラル
複雑な文字列結合や複数の文字列リテラルが絡む場合は、テンプレートリテラル（`）を使います。テンプレートリテラルは複数行にまたがっても構いません。

テンプレートリテラルが複数行にまたがる場合、囲むブロックのインデントに合わせる必要はありません（ただし、余分な空白が問題にならない場合は合わせてもよいです）。

例:

function arithmetic(a, b) {
  return `Here is a table of arithmetic operations:
${a} + ${b} = ${a + b}
${a} - ${b} = ${a - b}
${a} * ${b} = ${a * b}
${a} / ${b} = ${a / b}`;
}

5.6.3 行継続（バックスラッシュ）は禁止
通常の文字列リテラル・テンプレートリテラルのいずれでも、行末バックスラッシュによる行継続は使いません（ES5 で許可されていますが、末尾空白によるバグや可読性低下の原因となります）。

禁止例:

const longString = 'This is a very long string that far exceeds the 80 \
    column limit. It unfortunately contains long stretches of spaces due \
    to how the continued lines are indented.';

代わりに、次のように書きます:

const longString = 'This is a very long string that far exceeds the 80 ' +
    'column limit. It does not contain long stretches of spaces since ' +
    'the concatenated strings are cleaner.';

5.7 数値リテラル
数値は10進数、16進数、8進数、2進数で指定できます。16進数・8進数・2進数はそれぞれ 0x, 0o, 0b の小文字プレフィックスを必ず付けてください。先頭ゼロは x, o, b の直後以外では使いません。

5.8 制御構造
5.8.1 for文
ES6 では3種類の for 文が使えます。基本的にどれも使用可能ですが、可能な限り for-of を優先してください。

for-in は dict-style オブジェクト（5.3.3参照）にのみ使い、配列の走査には使いません。for-in では Object.prototype.hasOwnProperty を必ず使い、不要なプロトタイププロパティを除外してください。可能な限り for-of や Object.keys を使いましょう。

5.8.2 例外処理
例外は言語の重要な機能であり、例外的なケースが発生した場合は積極的に使ってください。throw する際は Error またはそのサブクラスのみを使い、文字列リテラルやその他のオブジェクトは投げないでください。Error の生成には必ず new を使います。

この扱いは Promise の reject 値にも適用されます（Promise.reject(obj) は async 関数内の throw obj; と等価です）。

標準の Error 型で不十分な場合は、独自の例外クラスを定義して使ってください。

例外を使わずにエラー情報を返す（エラー用プロパティを持つオブジェクトを返す等）よりも、例外を投げる方が推奨されます。

5.8.2.1 空の catch ブロック
catch ブロックで何もしないのは極めて稀です。本当に何も処理しない場合は、その理由をコメントで明記してください。

try {
  return handleNumericResponse(response);
} catch (ok) {
  // 数値でなければ問題ないので何もしない
}
return handleTextResponse(response);

禁止例:

  try {
    shouldFail();
    fail('expected an error');
  } catch (expected) {
  }

Tip: 上記のようなパターンは JavaScript では正しく動作しません。assertThrows() などを使いましょう。

5.8.3 switch文
用語: switch ブロックの中括弧内には1つ以上の「ステートメントグループ」があり、各グループは1つ以上の switch ラベル（case FOO: または default:）と1つ以上の文からなります。

5.8.3.1 フォールスルー時はコメント必須
switch ブロック内で、break/return/throw などで明示的に終了しない場合は、次のグループに処理が継続することを示すコメント（例: // fall through）を必ず記載してください。switch ブロックの最後のグループでは不要です。

例:

switch (input) {
  case 1:
  case 2:
    prepareOneOrTwo();
  // fall through
  case 3:
    handleOneTwoOrThree();
    break;
  default:
    handleLargeNumber(input);
}

5.8.3.2 defaultケースは必須
すべての switch 文には default グループを含めてください（たとえ中身が空でも）。default グループは必ず最後に書きます。

5.9 this の利用
this はクラスの constructor・メソッド、またはそれらの中で定義されたアロー関数、あるいは JSDoc で @this を明示した関数内でのみ使います。

グローバルオブジェクトや eval のコンテキスト、イベントターゲット、不要な call/apply で this を参照するのは禁止です。

5.10 等価性チェック
等価性の判定には原則として === / !== を使います。

5.10.1 型変換を許容する例外
null と undefined の両方をまとめて判定したい場合のみ == を使って構いません。

if (someObjectOrPrimitive == null) {
  // null/undefined の両方を検出できる（0や空文字列など他のfalsy値は含まない）
}

5.11 禁止機能
5.11.1 with の禁止
with キーワードは可読性を著しく損なうため使用禁止です。ES5 以降の strict mode でも禁止されています。

5.11.2 動的コード評価の禁止
eval や Function(...string) コンストラクタは（ローダ用途を除き）使用禁止です。CSP環境で動作しない・危険性が高い等の理由です。

5.11.3 自動セミコロン挿入の禁止
すべての文は必ずセミコロンで終わらせてください（function/class宣言を除く）。

5.11.4 非標準機能の禁止
非標準機能（削除済みの古い機能、標準化前の提案、特定ブラウザのみの拡張等）は使用禁止です。ECMA-262/WHATWG 標準に準拠した機能のみを使ってください（Chrome拡張やNode.js等、特定APIを対象とする場合は例外）。

5.11.5 プリミティブ型のラッパーオブジェクト禁止
Boolean, Number, String, Symbol などのラッパーオブジェクトを new して使うのは禁止です。型アノテーションにも使いません。

禁止例:

const /** Boolean */ x = new Boolean(false);
if (x) alert(typeof x);  // 'object' になるのでNG

ラッパー関数として呼び出して型変換するのはOKです。

例:

const /** boolean */ x = Boolean(0);
if (!x) alert(typeof x);  // 'boolean' になる

5.11.6 組み込みオブジェクトの拡張禁止
組み込み型のコンストラクタや prototype にメソッドを追加するのは禁止です。そうしたライブラリへの依存も避けてください。標準準拠のポリフィルは JSCompiler のランタイムライブラリが提供します。

グローバルオブジェクトへのシンボル追加も、やむを得ない場合（外部API要件等）以外は避けてください。

5.11.7 コンストラクタ呼び出し時の () 省略禁止
new でコンストラクタを呼ぶ際は必ず () を付けてください。

禁止例:

new Foo;

正しい例:

new Foo();

() を省略すると subtle なバグの原因になります。次の2行は同じ意味ではありません:

new Foo().Bar();
new Foo.Bar();

6 命名規則
6.1 すべての識別子に共通のルール
識別子は ASCII の英字・数字のみを使い、必要に応じてアンダースコアや（ごく稀に）$を使います。

できるだけ意味のある名前を付け、短縮形や省略形は避けてください。外部の人が理解できない略語や、単語内の文字を省略した形は使いません。

例:

errorCount          // 省略なし
dnsConnectionIndex  // 一般的な略語はOK
referrerUrl         // 同上
customerId          // "Id" は一般的なのでOK

禁止例:

n                   // 意味不明
nErr                // 曖昧な略語
nCompConns          // 同上
wgcConnections      // チーム内しか分からない略語
pcReader            // "pc" の意味が不明瞭
cstmrId             // 単語内の文字省略
kSecondsPerDay      // ハンガリアン記法禁止

例外: 10行以内のスコープやAPIに含まれない引数は短い名前でも可。

6.2 識別子の種類ごとのルール
6.2.1 パッケージ名
パッケージ名は lowerCamelCase。例: my.exampleCode.deepSpace

例外: TypeScript のパスベースパターンの場合は全小文字＋アンダースコア可。

6.2.2 クラス名
クラス・インターフェース・レコード・typedef 名は UpperCamelCase。未exportのクラスは @private なしのローカル名。

6.2.3 メソッド名
lowerCamelCase。@private メソッドは末尾に _ を付けてもよい。メソッド名は動詞または動詞句。

6.2.4 Enum名
UpperCamelCase。メンバは CONSTANT_CASE。

6.2.5 定数名
CONSTANT_CASE（全大文字＋アンダースコア区切り）。本当に不変な値のみ。

6.2.5.1 「定数」の定義
@const の静的プロパティまたはモジュールローカル const だが、すべての @const が定数とは限らない。状態が変化しうるものは定数名にしない。

6.2.5.2 ローカルエイリアス
可読性向上のため、import 名の末尾要素を使った const エイリアスを使ってよい。

6.2.6 非定数フィールド名
lowerCamelCase。@private フィールドは末尾 _ 可。

6.2.7 パラメータ名
lowerCamelCase。1文字名は公開APIでは避ける。

6.2.8 ローカル変数名
lowerCamelCase（関数スコープの定数も同様）。

6.2.9 テンプレートパラメータ名
TYPE, THIS など大文字の単語または1文字。

6.2.10 モジュールローカル名
export しないものは暗黙的に private。@private は不要。

6.3 キャメルケースの定義
英語フレーズを次の手順で変換:

- ASCII化・アポストロフィ削除
- 単語ごとに分割
- すべて小文字化し、UpperCamelCase または lowerCamelCase に変換
- 単語を連結

例:

Prose form	正しい	誤り
XML HTTP request	xmlHttpRequest	XMLHTTPRequest
new customer ID	newCustomerId	newCustomerID
inner stopwatch	innerStopwatch	innerStopWatch
supports IPv6 on iOS?	supportsIpv6OnIos	supportsIPv6OnIOS
YouTube importer	youTubeImporter	youtubeImporter*

7 JSDoc
すべてのクラス・フィールド・メソッドに JSDoc を付与します。

7.1 基本形式
JSDoc ブロックの基本フォーマット例:

/**
 * 複数行のJSDocテキストは通常通り折り返します。
 * @param {number} arg 説明
 */
function doSomething(arg) { … }

1行で収まる場合:

/** @const @private {!Foo} 短いJSDoc */
this.foo_ = foo;

1行コメントが複数行にまたがる場合は /** ... */ の複数行形式を使います。

JSDoc はツールによる型チェックや最適化にも使われるため、正しい構文で記述してください。

7.2 Markdown
JSDoc では Markdown が使えます（必要に応じてHTMLも可）。

リストなどは Markdown 形式で書いてください。

/**
 * Computes weight based on three factors:
 *
 *  - items sent
 *  - items received
 *  - last timestamp
 */

7.3 JSDocタグ
Googleスタイルでは JSDoc タグのサブセットのみ許可します（9.1参照）。ほとんどのタグは行頭にタグ名を書き、1行に1タグとします。

禁止例:

/**
 * "param" タグは1行に1つのみ。複数併記は禁止。
 * @param {number} left @param {number} right
 */
function add(left, right) { ... }

単純なタグ（@private, @const, @final, @export など）は型とともに1行にまとめてもよい。

/**
 * 複雑なアノテーション（"implements" や "template" など）は個別行に。
 * 複数の単純タグ（"export" や "final"）は1行にまとめてよい。
 * @export @final
 * @implements {Iterable<TYPE>}
 * @template TYPE
 */
class MyClass {
  /**
   * @param {!ObjType} obj Some object.
   * @param {number=} num An optional number.
   */
  constructor(obj, num = 42) {
    /** @private @const {!Array<!ObjType|number>} */
    this.data_ = [obj, num];
  }
}

タグの順序やまとめ方に厳密なルールはありませんが、一貫性を持たせてください。

型アノテーションの詳細は「Annotating JavaScript for the Closure Compiler」や「Types in the Closure Type System」を参照。

7.4 ラインラップ
JSDoc ブロックタグの折り返しは4スペースインデント。説明文の横方向アラインメントは任意ですが、推奨はしません。

/**
 * Illustrates line wrapping for long param/return descriptions.
 * @param {string} foo This is a param with a description too long to fit in
 *     one line.
 * @return {number} This returns something that has a description too long to
 *     fit in one line.
 */
exports.method = function(foo) {
  return 5;
};

@desc や @fileoverview の説明文を折り返す場合はインデントしません。

7.5 ファイル先頭コメント（Top/file-level comments）
ファイルにはトップレベルのファイル概要コメントを付けてもよいです。著作権表示、著者情報、デフォルトの可視性レベルは任意です。ファイル概要コメントは、ファイルが1つのクラス定義だけでない場合は推奨されます。トップレベルコメントは、そのファイルに何が含まれているかを初見の読者に説明するためのものです。依存関係や互換性情報なども記載できます。折り返した行はインデントしません。

例:

/**
 * @fileoverview ファイルの説明、用途、依存関係など
 * @package
 */

7.6 クラスコメント
クラス、インターフェース、レコードには説明、およびテンプレートパラメータ・実装インターフェース・可視性など必要なタグをJSDocで記述します。クラス説明は、読者がそのクラスの使い方や注意点を理解できるように十分な情報を含めてください。コンストラクタにはテキスト説明を省略しても構いません。classキーワードでクラスを定義する場合、@constructorや@extendsは（ジェネリック継承時以外）使いません。@interfaceや@recordの場合、サブクラス定義時は@extendsを使い、extendsキーワードは使いません。

/**
 * A fancier event target that does cool things.
 * @implements {Iterable<string>}
 */
class MyFancyTarget extends EventTarget {
  /**
   * @param {string} arg1 An argument that makes this more interesting.
   * @param {!Array<number>} arg2 List of numbers to be processed.
   */
  constructor(arg1, arg2) {
    // ...
  }
};

/**
 * Records are also helpful.
 * @extends {Iterator<TYPE>}
 * @record
 * @template TYPE
 */
class Listable {
  /** @return {TYPE} The next item in line to be returned. */
  next() {}
}

7.7 Enum・typedefコメント
すべてのenumやtypedefには、直前の行に適切なJSDocタグ（@typedefまたは@enum）を付けます。公開enumやtypedefには説明も必須です。個々のenum項目には、必要に応じてJSDocコメントを付けます。

/**
 * A useful type union, which is reused often.
 * @typedef {!FruitType|!FruitTypeEnum}
 */
let CoolUnionType;
 
/**
 * Types of fruits.
 * @enum {string}
 */
const FruitTypeEnum = {
  /** This kind is very sour. */
  SOUR: 'sour',
  /** The less-sour kind. */
  SWEET: 'sweet',
};

typedefは短いレコード型やユニオン、複雑な関数型、ジェネリック型のエイリアス定義に便利です。フィールドが多いレコード型には@recordを推奨します。

7.8 メソッド・関数コメント
メソッドや名前付き関数には、パラメータ・戻り値の型を必ずJSDocで記述します（@override時も同様）。this型が必要な場合は明示します。戻り値が常に空の場合は@returnを省略可。

メソッド・パラメータ・戻り値の説明（型ではなく説明文）は、他のJSDocやシグネチャから明らかな場合は省略できます。

メソッド説明は「このメソッドは…する」という三人称の動詞句で始めます（命令形ではなく）。

スーパークラスのメソッドをオーバーライドする場合、必ず@overrideを付け、@paramや@returnも明示します（TypeScriptとの整合性のため）。

/** A class that does something. */
class SomeClass extends SomeBaseClass {
  /**
   * Operates on an instance of MyClass and returns something.
   * @param {!MyClass} obj An object that for some reason needs detailed
   *     explanation that spans multiple lines.
   * @param {!OtherClass} obviousOtherClass
   * @return {boolean} Whether something occurred.
   */
  someMethod(obj, obviousOtherClass) { ... }

  /**
   * @param {string} param
   * @return {string}
   * @override
   */
  overriddenMethod(param) { ... }
}

/**
 * Demonstrates how top-level functions follow the same rules.  This one
 * makes an array.
 * @param {TYPE} arg
 * @return {!Array<TYPE>}
 * @template TYPE
 */
function makeArray(arg) { ... }

型だけを記述したい場合、関数シグネチャ内のインラインJSDocも使えます。

function /** string */ foo(/** number */ arg) {...}

説明やタグが必要な場合は、関数の直前にJSDocコメントを記述してください。値を返す関数には@returnタグが必要です。

class MyClass {
  /**
   * @param {number} arg
   * @return {string}
   */
  bar(arg) {...}
}

// 以下は不正なインラインJSDoc例
class MyClass {
  /** @return {string} */ foo() {...}
}
/** No function description allowed inline here. */ function bar() {...}
function /** Function description is also illegal here. */ baz() {...}

無名関数では型推論が十分でない場合や明示した方が読みやすい場合のみ、パラメータ・戻り値の型を注釈します:

promise.then(
    /** @return {string} */
    (/** !Array<string> */ items) => {
      doSomethingWith(items);
      return items[0];
    });

関数型注釈については 7.10.4 を参照。

7.9 プロパティコメント
プロパティの型は必ずJSDocで記述します。privateプロパティの場合、名前と型で十分なら説明は省略可。

公開定数もプロパティと同様にコメントします。

/** My class. */
class MyClass {
  /** @param {string=} someString */
  constructor(someString = 'default string') {
    /** @private @const {string} */
    this.someString_ = someString;

    /** @private @const {!OtherType} */
    this.someOtherThing_ = functionThatReturnsAThing();

    /**
     * Maximum number of things per pane.
     * @type {number}
     */
    this.someProperty = 4;
  }
}

/**
 * The number of times we'll try before giving up.
 * @const {number}
 */
MyClass.RETRY_COUNT = 33;

7.10 型注釈
型注釈は@param, @return, @this, @typeタグ、または@const, @export, 可視性タグに記述します。JSDocタグに付ける型注釈は必ず波括弧{}で囲みます。

7.10.1 Null許容性（Nullability）
型システムでは !（非null）と ?（null許容）の修飾子を使います。これらは型名の前に付けます。

- プリミティブ型（string, number, boolean, symbol, undefined, null）やリテラル型はデフォルトで非null。null許容にしたい場合のみ?を付けます。!は不要です。
- 参照型（UpperCamelCaseの型名など）はnullableかどうか名前だけでは分からないため、必ず!または?を明示します。

Bad例:

const /** MyObject */ myObject = null; // 参照型は明示必須
const /** !number */ someNum = 5; // プリミティブは!不要
const /** number? */ someNullableNum = null; // ?は型名の前
const /** !{foo: string, bar: number} */ record = ...; // リテラルは!不要
const /** MyTypeDef */ def = ...; // nullableか不明
const /** SomeCamelCaseName */ n = ...; // nullableか不明

Good例:

const /** ?MyObject */ myObject = null;
const /** number */ someNum = 5;
const /** ?number */ someNullableNum = null;
const /** {foo: string, bar: number} */ record = ...;
const /** !MyTypeDef */ def = ...;
const /** ?SomeCamelCaseName */ n = ...;

7.10.2 型キャスト
コンパイラが型推論できない場合やgoog.assertsで解決できない場合、型注釈コメント＋括弧で型を明示できます。括弧は必須です。

/** @type {number} */ (x)

7.10.3 テンプレート型パラメータ
テンプレート型パラメータは必ず指定してください。これにより型安全性と可読性が向上します。

Bad:

const /** !Object */ users = {};
const /** !Array */ books = [];
const /** !Promise */ response = ...;

Good:

const /** !Object<string, !User> */ users = {};
const /** !Array<string> */ books = [];
const /** !Promise<!Response> */ response = ...;
const /** !Promise<undefined> */ thisPromiseReturnsNothingButParameterIsStillUseful = ...;
const /** !Object<string, *> */ mapOfEverything = {};

Objectを型階層として使う場合のみテンプレートパラメータ省略可。

7.10.4 関数型注釈（Function type expressions）
function型注釈は、@typedef, @param, @returnなどで使います。関数定義そのものでは使わず、@param/@returnやインラインJSDocで型を指定します。

関数型注釈では必ず戻り値型も明示してください。省略するとunknown(?)型になり、予期せぬ動作の原因になります。

Bad:

/** @param {function()} generateNumber */
function foo(generateNumber) {
  const /** number */ x = generateNumber();  // 型エラーにならない
}
foo(() => 'clearly not a number');

Good:

/**
 * @param {function(): *} inputFunction1 Can return any type.
 * @param {function(): undefined} inputFunction2 Definitely doesn't return
 *      anything.
 * NOTE: the return type of `foo` itself is safely implied to be {undefined}.
 */
function foo(inputFunction1, inputFunction2) {...}

7.10.5 型注釈内の空白
型注釈内では、カンマやコロンの後に1つのスペースまたは改行を入れます。可読性や80カラム制限のために追加の改行も可。その他の空白は不可。

Good:

/** @type {function(string): number} */
/** @type {{foo: number, bar: number}} */
/** @type {number|string} */
/** @type {!Object<string, string>} */
/** @type {function(this: Object<string, string>, number): string} */
/**
 * @type {function(
 *     !SuperDuperReallyReallyLongTypedefThatForcesTheLineBreak,
 *     !OtherVeryLongTypedef): string}
 */
/**
 * @type {!SuperDuperReallyReallyLongTypedefThatForcesTheLineBreak|
 *     !OtherVeryLongTypedef}
 */

Bad:

// コロンの後だけ空白
/** @type {function(string) : number} */
// コロン・カンマの後に空白なし
/** @type {{foo:number,bar:number}} */
// ユニオン型の間に空白
/** @type {number | string} */

7.11 可視性アノテーション
可視性アノテーション（@private, @package, @protected）は@fileoverviewやエクスポートされるシンボル・プロパティに付けます。ローカル変数には付けません。@private名は末尾_でも可。

8 ポリシー
8.1 Google Styleで明記されていない事項: 一貫性を重視
この仕様で明確に定められていないスタイルの疑問点は、まず同じファイル内の他のコードに合わせてください。それでも決まらない場合は、同じパッケージ内の他ファイルを参考にします。

8.2 コンパイラ警告
8.2.1 標準の警告セットを使う
可能な限り --warning_level=VERBOSE を使ってください。

8.2.2 警告への対応方法
まず警告の意味を正確に理解してください。不明な場合は必ず相談しましょう。

理解できたら、以下の順で対応します:

1. 修正または回避策を試す。できるだけ警告の原因を直すか、他の方法で回避します。
2. 誤検知の場合は、その旨をコメントで説明し、@suppressアノテーションを付けます。
3. どうしても対応できない場合はTODOコメントを残します（この場合は警告抑制しない）。

8.2.3 警告抑制は最小スコープで
警告抑制（@suppress）は、できるだけ狭いスコープ（ローカル変数や小さなメソッド単位）で行います。必要なら変数やメソッドを抽出しても構いません。

例:

/** @suppress {uselessCode} Unrecognized 'use asm' declaration */
function fn() {
  'use asm';
  return 0;
}
多数のsuppressがクラス内にあっても、クラス全体を抑制するよりは良いです。

8.3 非推奨 (Deprecation)  
非推奨にするメソッド・クラス・インターフェースには @deprecated アノテーションを付与してください。非推奨コメントには、利用者が呼び出し箇所を修正するための簡潔で明確な指示を必ず含めます。

8.4 Google Style でないコード  
既存のコードベースには、Google Style に準拠していないファイルが存在する場合があります。これは買収によるもの、Google Style が策定される前に書かれたもの、その他の理由によるものです。

8.4.1 既存コードのリフォーマット  
既存コードのスタイルを更新する場合は、以下のガイドラインに従ってください。

すべての既存コードを現行のスタイルガイドに合わせて修正する必要はありません。既存コードのリフォーマットは、コードの変更量（churn）と一貫性のトレードオフです。スタイルルールは時間とともに進化するため、単なる準拠のためだけの修正は不要な churn を生みます。ただし、ファイルに大きな変更を加える場合は、そのファイル全体を Google Style に合わせることが期待されます。

CL（Change List）の主目的と関係ないスタイル修正が混在しないよう注意してください。スタイル修正が多くなりそうな場合は、別の CL として分離してください。

8.4.2 新規追加コード: Google Style を使用  
新規ファイルは、同じパッケージ内の他ファイルのスタイルに関わらず、必ず Google Style で記述してください。

Google Style でないファイルに新しいコードを追加する場合、まず既存コードをリフォーマットすることを推奨します（8.4.1参照）。  
リフォーマットしない場合でも、新しいコードはできる限り既存コードと一貫性を持たせつつ、スタイルガイドに違反してはなりません。

8.5 ローカルスタイルルール  
チームやプロジェクトで本ドキュメントに加えて独自のスタイルルールを採用しても構いませんが、クリーンアップ目的の変更がこれら追加ルールに従わなくてもブロックしてはいけません。目的のない過剰なルールには注意してください。本スタイルガイドもすべてのケースを網羅するものではありません。

8.6 生成コード: 原則として対象外  
ビルドプロセスで生成されるソースコードは、Google Style に準拠する必要はありません。ただし、手書きコードから参照される識別子は命名規則に従う必要があります。特例として、こうした識別子にはアンダースコアを含めてもよいです（手書き識別子との衝突回避のため）。

9 付録  
9.1 JSDoc タグリファレンス  
JSDoc は JavaScript で複数の目的に使われます。ドキュメント生成だけでなく、ツール制御（Closure Compiler の型アノテーション等）にも利用されます。

9.1.1 型アノテーションおよび Closure Compiler アノテーション  
Closure Compiler で使われる JSDoc については「Annotating JavaScript for the Closure Compiler」や「Types in the Closure Type System」を参照してください。

9.1.2 ドキュメント用アノテーション  
Closure Compiler 用以外にも、各種ドキュメント生成ツール（例: JsDossier）でよく使われるタグがあります。

9.1.2.1 @author, @owner - 非推奨  
非推奨です。

構文: @author username@google.com (First Last)

/**
 * @fileoverview Utilities for handling textareas.
 * @author kuth@google.com (Uthur Pendragon)
 */
ファイルの著者やテストのオーナーを記載します。@owner はユニットテストダッシュボードで利用されます。

9.1.2.2 @bug  
構文: @bug バグ番号

/** @bug 1234567 */
function testSomething() {
  // …
}

/**
 * @bug 1234568
 * @bug 1234569
 */
function testTwoBugs() {
  // …
}
このタグは、テスト関数がどのバグの回帰テストかを示します。複数バグの場合は1行ずつ記載してください。

9.1.2.3 @code - 非推奨。使用しないこと  
非推奨です。Markdown のバッククォート（`）を使ってください。

構文: {@code ...}

歴史的には `BatchItem` を {@code BatchItem} と書いていました。

/** Processes pending `BatchItem` instances. */
function processBatchItems() {}
JSDoc 内でコードとして強調表示するためのタグでした。

9.1.2.4 @desc  
構文: @desc メッセージ説明

/** @desc Notifying a user that their account has been created. */
exports.MSG_ACCOUNT_CREATED = goog.getMsg(
    'Your account has been successfully created.');
9.1.2.5 @link  
構文: {@link ...}

ドキュメント生成時のクロスリファレンス用タグです。

/** Processes pending {@link BatchItem} instances. */
function processBatchItems() {}
外部リンクには Markdown のリンク構文を使ってください。

/**
 * This class implements a useful subset of the
 * [native Event interface](https://dom.spec.whatwg.org/#event).
 */
class ApplicationEvent {}
9.1.2.6 @see  
構文: @see リンク

/**
 * Adds a single item, recklessly.
 * @see #addSafely
 * @see goog.Collect
 * @see goog.RecklessAdder#add
 */
他クラスや関数、メソッドへの参照を示します。

9.1.2.7 @supported  
構文: @supported 説明

/**
 * @fileoverview Event Manager
 * Provides an abstracted interface to the browsers' event systems.
 * @supported IE10+, Chrome, Safari
 */
対応ブラウザなどを示すために使います。

サードパーティコードでは他にも様々な JSDoc タグが見られますが、本ガイドでは標準的なもののみを有効とします。

9.1.3 フレームワーク固有のアノテーション  
以下は特定フレームワーク用です。

- @ngInject (Angular 1)
- @polymerBehavior (Polymer)
  https://github.com/google/closure-compiler/wiki/Polymer-Pass

9.1.4 標準 Closure Compiler アノテーションの注意  
以下のタグは現在は非推奨です。

- @expose - 非推奨。@export や @nocollapse を使ってください。
- @inheritDoc - 非推奨。@override を使ってください。

9.2 誤解されやすいスタイルルール  
Google Style for JavaScript の lesser-known/誤解されやすい事実集です（以下はすべて正しい記述です）。

- ソースファイルに著作権表示や @author クレジットは必須でも推奨でもありません。
- クラスのメンバー順序に厳密なルールはありません（5.4）。
- 空ブロックは通常 {} で簡潔に書けます（4.1.3）。
- ラインラップの最優先は「より高い構文レベルで折る」ことです（4.5.1）。
- 文字列リテラル・コメント・JSDoc には非ASCII文字も使えます。可読性が上がるなら Unicode エスケープより推奨です（2.3.3）。

9.3 スタイル関連ツール  
Google Style をサポートするツール群です。

9.3.1 Closure Compiler  
型チェックや最適化、ES5 への変換などを行うツールです。

9.3.2 clang-format  
JavaScript ソースコードを Google Style に自動整形します。必須ではありませんが、出力はスタイルガイド準拠です。

9.3.3 Closure compiler linter  
さまざまなアンチパターンやミスを検出します。

9.3.4 Conformance framework  
Closure Compiler の追加チェック機構です。特定プロパティや関数の禁止、型情報の欠落などを検出できます。セキュリティパターンや品質向上にも利用されます。詳細は公式ドキュメントを参照してください。

9.4 レガシープラットフォーム向け例外  
9.4.1 概要  
モダン ECMAScript 構文が使えない場合の例外・追加ルールです。  
- var 宣言の使用可  
- arguments の使用可  
- デフォルト値なしのオプションパラメータ可

9.4.2 var の使用  
9.4.2.1 var 宣言はブロックスコープではない  
var 宣言は最も近い関数・スクリプト・モジュールの先頭までスコープが広がります。ループ内で var を使うとクロージャで予期せぬ挙動になります。

for (var i = 0; i < 3; ++i) {
  var iteration = i;
  setTimeout(function() { console.log(iteration); }, i*1000);
}
// 2, 2, 2 と出力される（0, 1, 2 ではない）

9.4.2.2 変数宣言はできるだけ最初の利用箇所に近づける  
var 宣言はスコープの先頭にまとめず、できるだけ最初の利用箇所に近づけてください。ただし、ブロック内で宣言して外で参照する場合はブロック外で宣言します。

9.4.2.3 定数には @const を付与  
グローバル定数には const キーワードの代わりに @const アノテーションを付けてください（ローカル変数は任意）。

9.4.3 ブロックスコープ関数宣言は禁止  
if (x) { function foo() {} } のようなブロックスコープ関数宣言は禁止です。  
代わりに var で関数式を代入してください。

if (x) {
  var foo = function() {};
}

9.4.4 goog.provide/goog.require による依存管理  
9.4.4.1 概要  
※goog.provide 依存管理は非推奨です。新規ファイルは goog.module を使ってください。

- goog.provide を先に、goog.require を後に記述し、空行で区切る
- アルファベット順（大文字優先）で並べる
- 80カラム超でも折り返さない
- トップレベルシンボルのみ provide する

9.4.4.2 goog.scope によるエイリアス  
※goog.scope も非推奨です。新規ファイルでは使わないでください。

- ファイルごとに1回のみ、グローバルスコープで使う
- エイリアスは再代入しない名前のみ
- エイリアス名はグローバル名の末尾と一致させる

9.4.4.3 goog.forwardDeclare  
同一ライブラリ内の循環依存回避には goog.requireType を推奨します。goog.forwardDeclare はレガシー用途のみ。

9.4.4.4 goog.module.get(name)  
goog.provide ファイルが goog.module ファイルに依存する場合、グローバル名で参照できません。goog.require した上で goog.module.get('module.name') でエクスポートを取得します。

9.4.4.5 goog.module.declareLegacyNamespace()  
※移行用の一時的なものです。可能な限り早く削除してください。

goog.module(name) 内で呼ぶと、そのモジュールの名前空間をグローバル名として宣言します。レガシーな名前空間からの移行時のみ使用してください。


## セキュアな実践

