// Targeted edge-case differential tests vs the reference build().
import { pathToFileURL } from 'node:url';
const { run } = await import(pathToFileURL('./solve.js').href);
const refMod = await import(pathToFileURL('./baseline/vendor/makefun-site/index.js').href);
const ref = refMod.build;

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const T = (extra = {}) => ({
  page: '<h1>{{ page.title }}</h1>{{{ page.content }}}',
  post: '<article>{{ page.title }}|{{ page.date }}|{{{ page.content }}}</article>',
  index: '{% for p in posts %}<a href="{{ p.url }}">{{ p.title }}</a>{% endfor %}|{{ pager.number }}/{{ pager.total }}',
  tag: '#{{ tag.name }} ({{ tag.count }}):{% for p in tag.posts %}{{ p.title }}{% endfor %}',
  tags: '{% for t in tags %}{{ t.name }}={{ t.count }} {% endfor %}',
  ...extra,
});
const site = (o = {}) => ({ title: 'T', base_url: 'https://x.example', per_page: 10, recent: 3, ...o });
const md = (title, body, extra = '') => `---\ntitle: ${title}\n${extra}---\n${body}`;

const tests = [
  ['empty', { site: site(), templates: T(), files: [] }],
  ['only-static', { site: site(), templates: T(), files: [{ path: 'a.txt', content: 'hi' }, { path: 'robots.txt', content: 'x' }] }],
  ['all-drafts', { site: site(), templates: T(), files: [
    { path: 'p.md', content: md('A', 'body', 'draft: true\n') }] }],
  ['no-posts', { site: site(), templates: T(), files: [
    { path: 'a.md', content: md('Page A', 'hello') },
    { path: 'docs/b.md', content: md('Page B', 'world') }] }],
  ['no-tags', { site: site(), templates: T(), files: [
    { path: 'posts/2020/a.md', content: md('Post', 'x', 'date: 2020-01-01\n') }] }],
  ['missing-index-tag-tags', { site: site(), templates: { page: 'P{{ page.title }}', post: '{{ page.title }}' }, files: [
    { path: 'posts/2020/a.md', content: md('Post', 'x', 'date: 2020-01-01\ntags: [x]\n') }] }],
  ['per-page-big', { site: site({ per_page: 100 }), templates: T(), files: [
    { path: 'posts/2020/a.md', content: md('A', 'x', 'date: 2020-01-01\n') },
    { path: 'posts/2020/b.md', content: md('B', 'y', 'date: 2020-01-02\n') }] }],
  ['circular-include', { site: site(), templates: T({ a: '{% include "b" %}', b: '{% include "a" %}ok', page: '{% include "a" %}{{ page.title }}' }), files: [
    { path: 'a.md', content: md('A', 'x') }] }],
  ['md-corners', { site: site(), templates: T(), files: [
    { path: 'a.md', content: md('A & B <c>', '# H1\n## H2 ##\n####### no\n#nospace\n```js\n<b>&\n```\n---\n***\n> quote\n> \n- a\n- b\n  cont\n1. x\n2. y\n\npara with *em* **strong** `code` [l](https://x.y) \\* esc\n    indented not code\n=== \n') }] }],
  ['slug-collisions', { site: site(), templates: T(), files: [
    { path: 'a.md', content: md('Hello World', '1') },
    { path: 'b.md', content: md('hello world!!', '2') },
    { path: 'c.md', content: md('HELLO WORLD', '3') }] }],
  ['refused-and-broken', { site: site(), templates: T(), files: [
    { path: 'a.md', content: md('A', 'see [x](missing.md) and [y](./nope.md)') },
    { path: 'bad.md', content: '---\ntitle: ok\nauthor: x\n---\nbody' },
    { path: 'nodate.md', content: '---\ntitle: p\n---\nbody' }] }],
  ['unicode-slug', { site: site(), templates: T(), files: [
    { path: 'u.md', content: md('Café Zürich naïve 東京 Straße', 'body') }] }],
  ['crlf', { site: site(), templates: T(), files: [
    { path: 'c.md', content: '---\r\ntitle: CRLF Post\r\n---\r\nline1\r\nline2\r\n' }] }],
  ['shadowed-static', { site: site(), templates: T(), files: [
    { path: 'index.html', content: 'static index' },
    { path: 'a.md', content: md('A', 'x') }] }],
  ['empty-posts-index', { site: site(), templates: T(), files: [
    { path: 'a.md', content: md('A', 'x') }] }],
];

let fail = 0;
for (const [name, input] of tests) {
  let a, b, err = null;
  try { a = ref(JSON.parse(JSON.stringify(input))); } catch (e) { err = 'ref threw: ' + e.message; }
  try { b = run(JSON.parse(JSON.stringify(input))); } catch (e) { err = (err || '') + ' cand threw: ' + e.message; }
  if (err) { console.log(`ERROR ${name}: ${err}`); fail++; continue; }
  if (canonical(a) === canonical(b)) console.log(`PASS ${name}`);
  else {
    fail++;
    console.log(`FAIL ${name}`);
    const ak = Object.keys(a), bk = Object.keys(b);
    const miss = ak.filter((k) => !(k in b)), extra = bk.filter((k) => !(k in a));
    if (miss.length) console.log('  missing:', miss);
    if (extra.length) console.log('  extra:', extra);
    for (const k of ak) if (k in b && canonical(a[k]) !== canonical(b[k])) {
      let i = 0; while (i < a[k].length && a[k][i] === b[k][i] && i < b[k].length) i++;
      console.log(`  diff ${k} @${i}: exp ${JSON.stringify(a[k].slice(Math.max(0,i-30),i+30))} got ${JSON.stringify(b[k].slice(Math.max(0,i-30),i+30))}`);
      break;
    }
  }
}
console.log(`\n${tests.length - fail}/${tests.length} edge tests pass`);
process.exit(fail ? 1 : 0);