// Test runner: runs a solve.js's run() over practice cases and compares to expected.json
// using the scorer's canonical comparison. Usage: node run_test.mjs <path-to-solve.js>
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const solvePath = process.argv[2] || join(__dirname, 'solve.js');
const casesPath = process.argv[3] || '/tmp/sg_kit/site-generator-speed-01-run-20261122-kit/practice/input/cases.json';
const expectedPath = process.argv[4] || '/tmp/sg_kit/site-generator-speed-01-run-20261122-kit/practice/reference/expected.json';

const { run } = await import(pathToFileURL(solvePath).href);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// expected.cases: [{id, group, output}]
let passed = 0;
const t0 = process.hrtime.bigint();
const answers = cases.map((c) => run(c.input));
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;

for (let i = 0; i < cases.length; i++) {
  const exp = expected.cases[i];
  const ok = canonical(answers[i]) === canonical(exp.output);
  if (ok) { passed++; console.log(`PASS ${cases[i].id}`); }
  else {
    console.log(`FAIL ${cases[i].id}`);
    // find first diff path
    const a = answers[i], e = exp.output;
    const ak = Object.keys(a), ek = Object.keys(e);
    const missing = ek.filter((k) => !(k in a));
    const extra = ak.filter((k) => !(k in e));
    if (missing.length) console.log('  missing keys:', missing.slice(0, 10));
    if (extra.length) console.log('  extra keys:', extra.slice(0, 10));
    for (const k of ek) {
      if (k in a && canonical(a[k]) !== canonical(e[k])) {
        console.log(`  first diff at ${k}:`);
        console.log(`    expected: ${JSON.stringify(e[k]).slice(0, 300)}`);
        console.log(`    got:      ${JSON.stringify(a[k]).slice(0, 300)}`);
        break;
      }
    }
  }
}
console.log(`\n${passed}/${cases.length} passed in ${ms.toFixed(1)} ms (run only)`);
process.exit(passed === cases.length ? 0 : 1);