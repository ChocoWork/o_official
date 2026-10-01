#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const canonicalDirs = [
  'docs/01_Planning',
  'docs/02_Requirements',
  'docs/03_BasicDesign',
  'docs/04_DetailDesign',
  'docs/05_Quality',
  'docs/06_Operations',
];
const entryDocs = [
  'docs/README.md',
  'docs/01_Planning/system-context.md',
  'docs/02_Requirements/requirements.md',
  'docs/02_Requirements/use-cases.md',
  'docs/03_BasicDesign/ui/screen-list.md',
  'docs/03_BasicDesign/ui/screen-flow.md',
  'docs/03_BasicDesign/architecture/system-overview.md',
  'docs/03_BasicDesign/data/er.md',
  'docs/03_BasicDesign/api/api-spec.md',
  'docs/04_DetailDesign/sequence/auth-login-mfa.md',
  'docs/04_DetailDesign/states/order-payment.md',
  'docs/05_Quality/tests/test-spec.md',
  'docs/06_Operations/deployment-topology.md',
];
const errors = [];
let diagramCount = 0;
let linkCount = 0;

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && full.endsWith('.md') ? [full] : [];
  });
}

function checkFrontmatter(content, file) {
  if (!content.startsWith('---')) return;
  const end = content.indexOf('\n---', 3);
  if (end < 0) {
    errors.push(`${file}: frontmatter is not closed`);
    return;
  }
  try {
    require('js-yaml').load(content.slice(3, end + 1));
  } catch (error) {
    errors.push(`${file}: invalid YAML frontmatter: ${error.message}`);
  }
}

function checkLinks(content, file) {
  const withoutFences = content.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  const links = withoutFences.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g);
  for (const match of links) {
    let target = match[1].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|data:|#|\/)/i.test(target)) continue;
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      errors.push(`${file}: invalid link encoding: ${match[1]}`);
      continue;
    }
    linkCount += 1;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      errors.push(`${file}: broken relative link: ${match[1]}`);
    }
  }
}

async function main() {
  for (const dir of canonicalDirs) {
    if (!fs.existsSync(dir)) errors.push(`missing canonical directory: ${dir}`);
  }
  for (const file of entryDocs) {
    if (!fs.existsSync(file)) errors.push(`missing entry document: ${file}`);
  }
  const canonical = canonicalDirs.flatMap(markdownFiles);
  if (canonical.length === 0) errors.push('no canonical Markdown files found');
  const files = [...new Set(['docs/README.md', ...canonical, ...markdownFiles('docs/superpowers')])]
    .filter((file) => fs.existsSync(file));

  let mermaid;
  try {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;
    mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  } catch (error) {
    errors.push(`Mermaid parser unavailable: ${error.message}`);
  }

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const isCanonical = file === 'docs/README.md' || canonical.includes(file);
    if (isCanonical && !/^# .+/m.test(content)) errors.push(`${file}: missing H1`);
    if (isCanonical && !/^## 概要\s*$/m.test(content)) errors.push(`${file}: missing overview`);
    checkFrontmatter(content, file);
    const fences = content.match(/^```/gm) || [];
    if (fences.length % 2 !== 0) errors.push(`${file}: unmatched code fence`);
    checkLinks(content, file);
    if (mermaid) {
      for (const match of content.matchAll(/^```mermaid\s*\n([\s\S]*?)^```/gm)) {
        diagramCount += 1;
        try {
          await mermaid.parse(match[1]);
        } catch (error) {
          errors.push(`${file}: invalid Mermaid diagram: ${error.message}`);
        }
      }
    }
  }

  for (const error of errors) console.error(error);
  if (errors.length) {
    console.error(`Documentation validation failed: ${errors.length} error(s).`);
    process.exitCode = 2;
    return;
  }
  console.log(`Documentation validation passed: ${canonical.length} canonical files, ${files.length} total Markdown files, ${linkCount} relative links, ${diagramCount} Mermaid diagrams.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
