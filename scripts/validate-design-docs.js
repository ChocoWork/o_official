#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let hasError = false;

function readFiles(dir){
  const out = [];
  if(!fs.existsSync(dir)) return out;
  const items = fs.readdirSync(dir);
  for(const item of items){
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if(stat.isDirectory()){
      out.push(...readFiles(full));
    } else if(full.endsWith('.md')){
      out.push(full);
    }
  }
  return out;
}

function checkFrontmatter(content, file){
  if(content.startsWith('---')){
    const end = content.indexOf('\n---', 3);
    if(end === -1){
      console.error(`Frontmatter not closed in ${file}`);
      hasError = true;
      return;
    }
    const yaml = content.slice(3, end+1);
    try{
      require('js-yaml').load(yaml);
    }catch(e){
      console.error(`Invalid YAML frontmatter in ${file}: ${e.message}`);
      hasError = true;
    }
  }
}

function checkCodeFences(content, file){
  const fenceCount = (content.match(/```/g) || []).length;
  if(fenceCount % 2 !== 0){
    console.error(`Unmatched code fences in ${file}`);
    hasError = true;
  }
}

async function checkMermaid(content, file){
  const mermaidBlocks = [...content.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  if(mermaidBlocks.length === 0) return;
  let mermaid;
  try{
    mermaid = require('mermaid');
    // initialize mermaid (if necessary)
    if(mermaid.initialize) {
      mermaid.initialize({startOnLoad:false});
    }
  }catch(e){
    console.warn('mermaid package not installed - skipping mermaid validation. Run `npm i -D mermaid` to enable.');
    return;
  }

  for(const b of mermaidBlocks){
    const diagram = b[1];
    try{
      // mermaid.parse may throw for invalid diagrams
      if(typeof mermaid.parse === 'function'){
        mermaid.parse(diagram);
      } else if(mermaid.mermaidAPI && mermaid.mermaidAPI.parse){
        mermaid.mermaidAPI.parse(diagram);
      } else {
        console.warn('mermaid parse API not available - skipping parse check');
      }
    }catch(e){
      console.error(`Mermaid syntax error in ${file}: ${e.message}`);
      hasError = true;
    }
  }
}

(async function main(){
  const dirs = ['docs/ArchitectureDesign','docs/DetailDesign'];
  const files = dirs.flatMap(d=>readFiles(d));
  if(files.length === 0){
    console.warn('No design markdown files found in docs/ArchitectureDesign or docs/DetailDesign');
  }
  for(const file of files){
    const content = fs.readFileSync(file,'utf8');
    checkFrontmatter(content,file);
    checkCodeFences(content,file);
    await checkMermaid(content,file);
  }
  if(hasError){
    console.error('\nValidation failed. Fix the errors above and re-run `npm run validate-docs`.');
    process.exit(2);
  }
  console.log('All design docs passed validation checks.');
})();
