// Differential fuzzer: generate random sites with the competition's own generator,
// run baseline (reference) and candidate solve.js, compare canonical output.
// Usage: node fuzz.mjs <candidate-solve.js> [num-sites] [seed]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const GEN = '/tmp/sg_kit/site-generator-speed-01-run-20261122-kit/program/generator';
const { generate } = await import(pathToFileURL(GEN + '/subject/sites.mjs').href);
const refMod = await import(pathToFileURL('/Users/user/bounty/site-generator/baseline/vendor/makefun-site/index.js').href);
const refRun = refMod.build;

// --- port of rng.ts (xoshiro128**) ---
const RNG_DOMAIN = 'makefun/speed-home/rng/v1';
const rotl = (x, k) => (x << k) | (x >>> (32 - k));
class Rng {
  constructor(key) {
    const v = new DataView(key.buffer, key.byteOffset, 16);
    this.a = v.getUint32(0) | 0; this.b = v.getUint32(4) | 0;
    this.c = v.getUint32(8) | 0; this.d = v.getUint32(12) | 0;
  }
  u32() {
    const a = this.a, b = this.b;
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    let c = this.c ^ a, d = this.d ^ b;
    const nb = b ^ c, na = a ^ d;
    c ^= t; d = rotl(d, 11);
    this.a = na; this.b = nb; this.c = c; this.d = d;
    return result;
  }
  int(lo, hi) {
    const span = hi - lo + 1;
    if (span === 2 ** 32) return lo + this.u32();
    const limit = Math.floor(2 ** 32 / span) * span;
    let x = this.u32();
    while (x >= limit) x = this.u32();
    return lo + (x % span);
  }
  float() { return this.u32() / 2 ** 32; }
  pick(xs) { return xs[this.int(0, xs.length - 1)]; }
  chance(p) { return this.float() < p; }
}
function streamFor(seed, label, index) {
  const key = createHash('sha256').update(`${RNG_DOMAIN}\n${seed}\n${label}\n${index}`).digest();
  return new Rng(key);
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const candPath = process.argv[2];
const N = parseInt(process.argv[3] || '30', 10);
const seed = process.argv[4] || 'fuzzseed0000000000000000000000000000000000000000000000000000000000';
const { run: candRun } = await import(pathToFileURL(candPath).href);

let fails = 0;
const tRef = { v: 0 }, tCand = { v: 0 };
for (let i = 0; i < N; i++) {
  const input = generate(streamFor(seed, 'case', i), i);
  // deep copy via JSON so neither run can mutate the other's input
  const inRef = JSON.parse(JSON.stringify(input));
  const inCand = JSON.parse(JSON.stringify(input));
  let a, b;
  let t0 = process.hrtime.bigint(); a = refRun(inRef); let t1 = process.hrtime.bigint();
  b = candRun(inCand); let t2 = process.hrtime.bigint();
  tRef.v += Number(t1 - t0) / 1e6; tCand.v += Number(t2 - t1) / 1e6;
  const ca = canonical(a), cb = canonical(b);
  if (ca !== cb) {
    fails++;
    console.log(`FAIL case ${i} (band ${i % 3})`);
    const ak = Object.keys(a), bk = Object.keys(b);
    const missing = ak.filter((k) => !(k in b));
    const extra = bk.filter((k) => !(k in a));
    if (missing.length) console.log('  missing:', missing.slice(0, 8));
    if (extra.length) console.log('  extra:', extra.slice(0, 8));
    for (const k of ak) {
      if (k in b && canonical(a[k]) !== canonical(b[k])) {
        console.log(`  diff at ${k}:`);
        console.log(`    ref:  ${JSON.stringify(a[k]).slice(0, 400)}`);
        console.log(`    cand: ${JSON.stringify(b[k]).slice(0, 400)}`);
        break;
      }
    }
    if (fails >= 5) { console.log('stopping after 5 fails'); break; }
  }
}
console.log(`\n${N - fails}/${N} match. ref ${tRef.v.toFixed(0)}ms, cand ${tCand.v.toFixed(0)}ms, speedup ${(tRef.v / tCand.v).toFixed(2)}x`);
process.exit(fails === 0 ? 0 : 1);