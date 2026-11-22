// Markdown/inline-focused differential fuzz: random bodies heavy in special chars.
import { pathToFileURL } from 'node:url';
const { run } = await import(pathToFileURL('./solve.js').href);
const refMod = await import(pathToFileURL('./baseline/vendor/makefun-site/index.js').href);
const ref = refMod.build;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
function mulberry32(a) { return function() { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const ALPHA = ['*', '**', '`', '[', ']', '(', ')', '\\', '<', '>', '&', '"', "'", '#', '+', '-', '.', '!', '_', ' ', 'a', 'b', 'word', 'x', '\n', '\t', '```', '---', '***', '> ', '- ', '1. ', '## ', '[t](u)', '[t](/abs)', '[t](#f)', '**b**', '*e*', '`c`', '\\*', '\\\\'];
function randInline(rng) {
  const n = 1 + Math.floor(rng() * 25);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHA[Math.floor(rng() * ALPHA.length)];
  return s;
}

const N = parseInt(process.argv[2] || '3000', 10);
const rng = mulberry32(parseInt(process.argv[3] || '12345', 10));
let fail = 0;
for (let t = 0; t < N; t++) {
  // build one source with random body; compare full output HTML
  const body = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randInline(rng)).join('\n');
  const input = {
    site: { title: 'T', base_url: 'https://x.example', per_page: 10, recent: 3 },
    templates: { page: '{{{ page.content }}}', post: '{{{ page.content }}}', index: '', tag: '', tags: '' },
    files: [
      { path: 'a.md', content: `---\ntitle: A\n---\n${body}` },
      { path: 'b.md', content: `---\ntitle: B\n---\n${body}` },
    ],
  };
  const a = ref(JSON.parse(JSON.stringify(input)));
  const b = run(JSON.parse(JSON.stringify(input)));
  if (canonical(a) !== canonical(b)) {
    fail++;
    console.log(`FAIL case ${t}`);
    console.log('  body:', JSON.stringify(body));
    for (const k of Object.keys(a)) if (k in b && canonical(a[k]) !== canonical(b[k])) {
      let i = 0; while (i < a[k].length && a[k][i] === b[k][i] && i < b[k].length) i++;
      console.log(`  diff ${k} @${i}:\n    exp ${JSON.stringify(a[k].slice(Math.max(0,i-40),i+50))}\n    got ${JSON.stringify(b[k].slice(Math.max(0,i-40),i+50))}`);
      break;
    }
    if (fail >= 8) { console.log('stop'); break; }
  }
}
console.log(`\n${N - fail}/${N} inline-fuzz match`);
process.exit(fail ? 1 : 0);