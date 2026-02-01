#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readDirMd(dir){
  if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f=>f.endsWith('.md')).map(f=>path.join(dir,f));
}

function extractReqsFromArch(archFile){
  const content = fs.readFileSync(archFile,'utf8');
  const reqs = [];
  const re = /-\s*(REQ-[A-Z0-9_-]+)\s*—\s*(.+)/g;
  let m;
  while((m = re.exec(content)) !== null){
    reqs.push({id: m[1], desc: m[2].trim()});
  }
  // also from table rows
  const tableRe = /\|\s*(REQ-[A-Z0-9_-]+)\s*\|\s*([^|]+)/g;
  while((m = tableRe.exec(content)) !== null){
    const id = m[1]; const desc = m[2].trim();
    if(!reqs.find(r=>r.id===id)) reqs.push({id, desc});
  }
  return reqs;
}

function fileContainsKeyword(file, keywords){
  const content = fs.readFileSync(file,'utf8').toLowerCase();
  for(const k of keywords){
    if(content.includes(k.toLowerCase())) return true;
  }
  return false;
}

function keywordsFromDesc(desc){
  // split japanese/english words, remove short tokens
  return desc.split(/[\s\/,_\(\)·\-〜:]+/).filter(s=>s.length>2);
}

(function main(){
  const archFiles = readDirMd('docs/ArchitectureDesign');
  const specFiles = fs.readdirSync('docs').filter(f=>f.startsWith('specs')||f==='seq' ).flatMap(fn=>readDirMd(path.join('docs',fn))).concat(readDirMd('docs/specs'));
  // fallback include docs/specs and docs/seq
  const specs = [...readDirMd('docs/specs'), ...readDirMd('docs/seq')];

  const archReqs = archFiles.flatMap(f=>extractReqsFromArch(f));
  const report = {covered:[], missing_in_spec:[], missing_in_detailed:[]};

  // Check presence in specs and seq (specs + seq files)
  for(const r of archReqs){
    const keywords = keywordsFromDesc(r.desc);
    let foundInSpec = false;
    for(const spec of specs){
      if(fileContainsKeyword(spec, keywords)){
        foundInSpec = true; break;
      }
    }
    if(foundInSpec) report.covered.push(r.id);
    else report.missing_in_spec.push({id:r.id,desc:r.desc});
  }

  // Check presence in detailed design
  const detailedFiles = readDirMd('docs/DetailDesign');
  for(const r of archReqs){
    let foundInDetailed = false;
    for(const df of detailedFiles){
      const content = fs.readFileSync(df,'utf8');
      if(content.includes(r.id) || content.includes(r.desc.split(' ')[0])){
        foundInDetailed = true; break;
      }
    }
    if(!foundInDetailed) report.missing_in_detailed.push({id:r.id,desc:r.desc});
  }

  const out = [];
  out.push('# Coverage Report');
  out.push('Generated: ' + new Date().toISOString());
  out.push('\n## Summary');
  out.push(`Total requirements discovered in ArchitectureDesign: ${archReqs.length}`);
  out.push(`Covered in specs/seq: ${report.covered.length}`);
  out.push(`Missing in specs/seq: ${report.missing_in_spec.length}`);
  out.push(`Missing in detailed design: ${report.missing_in_detailed.length}`);
  out.push('\n---\n');
  if(report.missing_in_spec.length>0){
    out.push('## Missing in Spec/Seq');
    for(const m of report.missing_in_spec) out.push(`- ${m.id}: ${m.desc}`);
  }
  if(report.missing_in_detailed.length>0){
    out.push('\n## Missing in Detailed Design');
    for(const m of report.missing_in_detailed) out.push(`- ${m.id}: ${m.desc}`);
  }
  out.push('\n\n## Notes');
  out.push('If any items are missing, please update the spec/sequence diagrams or the design docs to ensure traceability.');

  const outPath = 'docs/ArchitectureDesign/coverage-report.md';
  fs.writeFileSync(outPath, out.join('\n'));
  console.log('Coverage report written to', outPath);
  if(report.missing_in_spec.length>0 || report.missing_in_detailed.length>0){
    console.warn('Coverage gaps detected. Please review', outPath);
    process.exit(2);
  }
  console.log('Coverage OK: All ARCH requirements appear in spec and detailed design.');
})();
