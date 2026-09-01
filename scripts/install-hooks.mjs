/**
 * scripts/hooks/* を .git/hooks/ へ設置する。
 *
 * husky は使わない。husky は core.hooksPath を書き換えるため、導入すると
 * graphify が .git/hooks に入れている post-commit / post-checkout が
 * 黙って無効化されてしまう。
 *
 * 代わりに、既存フックがある場合は末尾へ「追記」し、自分の範囲を
 * マーカーで囲って識別する。再実行するとマーカー間だけを差し替えるので、
 * 何度実行しても重複しないし、他人のフックにも触らない。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_DIR = join(process.cwd(), "scripts", "hooks");
const TARGET_DIR = join(process.cwd(), ".git", "hooks");
const START = "# o-official-hook-start";
const END = "# o-official-hook-end";

if (!existsSync(TARGET_DIR)) {
  mkdirSync(TARGET_DIR, { recursive: true });
}

/** フック本体を、呼び出し用の 1 行に畳んだブロックにする。 */
function buildBlock(name) {
  return [
    START,
    `# scripts/hooks/${name} に委譲する。中身はリポジトリで管理されている。`,
    `"$(git rev-parse --show-toplevel)/scripts/hooks/${name}" "$@" || exit $?`,
    END,
  ].join("\n");
}

let installed = 0;

for (const name of readdirSync(SOURCE_DIR)) {
  const target = join(TARGET_DIR, name);
  const block = buildBlock(name);

  let content;
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    const startIdx = existing.indexOf(START);
    const endIdx = existing.indexOf(END);

    if (startIdx >= 0 && endIdx > startIdx) {
      // すでに設置済み。マーカー間だけ差し替える。
      content = existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
    } else {
      // 他のツール（graphify など）のフックがある。壊さずに追記する。
      const needsNewline = existing.endsWith("\n") ? "" : "\n";
      content = `${existing}${needsNewline}\n${block}\n`;
    }
  } else {
    content = `#!/bin/sh\n\n${block}\n`;
  }

  writeFileSync(target, content);
  try {
    chmodSync(target, 0o755);
  } catch {
    // Windows では実行ビットの概念が無い。Git for Windows は sh で起動するので問題ない。
  }

  console.log(`installed: .git/hooks/${name}`);
  installed += 1;
}

console.log(`\n${installed} 個のフックを設置しました。`);
console.log("既存のフック（graphify の post-commit / post-checkout など）はそのまま残っています。");
