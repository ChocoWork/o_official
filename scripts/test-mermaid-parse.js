const mermaid = require('mermaid');
const diagram = `flowchart LR
  User[ユーザ]
  Browser[ブラウザ]
  API[APIサーバ (/api/auth/*)]
  Auth[Supabase Auth]
  DB[Postgres]
  Mail[Mail Service (SES)]
  Audit[AuditLog]

  User --> Browser
  Browser --> API
  API --> Auth
  Auth --> DB
  API --> DB
  API --> Audit
  API --> Mail
`;
try{
  if(typeof mermaid.parse === 'function') mermaid.parse(diagram);
  else if(mermaid.mermaidAPI && mermaid.mermaidAPI.parse) mermaid.mermaidAPI.parse(diagram);
  console.log('parse OK');
}catch(e){
  console.error('parse error:', e && e.message ? e.message : e);
  console.error(e);
  process.exit(1);
}
