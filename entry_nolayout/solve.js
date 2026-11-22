// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// run(input) returns exactly what makefun-site 1.0.0's build() returns: the output
// tree as a JSON object of path -> text. Dependency-free ES module (Node 22).
//
// The pipeline and every rule follow the reference (vendor/makefun-site/). The hot
// paths are optimised: inline Markdown rendering batches plain runs and uses a
// no-scan escape fast path; slugify and reading-minutes are memoised per build;
// the template renderer avoids per-iteration garbage where it can. Output is
// byte-for-byte identical to the reference on every case.

// ============================================================ text rules

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const ESC_FN = (c) => ESCAPES[c];

/** `text` with & < > " ' escaped (README "Text"). Fast path when nothing to escape. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, ESC_FN) : text;
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const SLUG_NONALNUM = /[^a-z0-9]+/g;
const SLUG_TRIM = /^-+|-+$/g;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, runs of other
 *  characters one "-", none at either end, <= 64 chars, "untitled" when empty.
 *  ASCII text (the common case) skips the Unicode normalisation entirely. */
function slugify(text) {
  let out;
  if (NON_ASCII.test(text)) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;            // A-Z -> a-z
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code; // a-z 0-9
      if (keep < 0) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
  } else {
    out = text.toLowerCase().replace(SLUG_NONALNUM, '-').replace(SLUG_TRIM, '');
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words: "2026-11-09" -> "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.charCodeAt(5) * 10 + date.charCodeAt(6) - 48 * 11; // (d5-'0')*10 + (d6-'0')
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ============================================================ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEYSET = new Set(KEYS);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUGRE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANKLINE = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." (only \" and \\ escapes) or bare (never opening " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // starts with "
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n; i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUGRE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body } or { error }. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANKLINE.test(line) || line.charCodeAt(0) === 35) continue; // # comment
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYSET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ============================================================ markdown

const M_BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const TRIMLINE_RE = /^[ \t]+|[ \t]+$/g;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  return M_BLANK.test(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line);
}

const trimLine = (line) => line.replace(TRIMLINE_RE, '');

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const line = lines[i];
    if (M_BLANK.test(line)) { i++; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < N && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang: fence[1], lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) { tokens.push({ type: 'heading', depth: heading.depth, text: heading.text }); i++; continue; }
    if (HR.test(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < N && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < N) {
        const m = marker.exec(lines[i]);
        if (m !== null) { items.push([trimLine(isOrdered ? m[2] : m[1])]); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

// Characters a backslash escapes (as a lookup on charCode for speed).
// \ ` * _ [ ] ( ) # + - . ! >
function isEscapable(code) {
  switch (code) {
    case 92: case 96: case 42: case 95: case 91: case 93: case 40: case 41:
    case 35: case 43: case 45: case 46: case 33: case 62:
      return true;
    default:
      return false;
  }
}

/** The first index from `from` where `s` holds `what` (1 or 2 chars) outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  const w0 = what.charCodeAt(0);
  const last = s.length - wlen;
  if (wlen === 1) {
    for (let j = from; j <= last; j++) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
      if (c === w0) return j;
    }
    return -1;
  }
  const w1 = what.charCodeAt(1);
  for (let j = from; j <= last; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === w0 && s.charCodeAt(j + 1) === w1) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const N = s.length;
  for (let j = from; j < N; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < N && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
// A string with none of these cannot start any inline construct, so it is all plain text.
const CONSTRUCT_RE = /[\\`*\[]/;
// The same class, global, to jump straight to the next construct and skip plain runs at C speed.
const CONSTRUCT_G = /[\\`*\[]/g;

/** `src` rendered inline; `env.link(target)` is a link's href. Scans construct to construct,
 *  escaping the plain runs between them in bulk, building the result with string concat. */
function inline(s, env) {
  if (!CONSTRUCT_RE.test(s)) return escapeHtml(s); // fast path: no backslash, backtick, star or bracket
  const N = s.length;
  let out = '';
  let plain = 0; // start of the pending plain-text run
  let i = 0;
  while (i < N) {
    CONSTRUCT_G.lastIndex = i;
    const m = CONSTRUCT_G.exec(s);
    if (m === null) break; // the rest is plain
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      if (j + 1 < N && isEscapable(s.charCodeAt(j + 1))) {
        if (j > plain) out += escapeHtml(s.slice(plain, j));
        const ec = s[j + 1];
        out += ec === '>' ? '&gt;' : ec; // only '>' of the escapables is HTML-special
        i = j + 2; plain = i; continue;
      }
      i = j + 1; continue; // lone backslash: plain
    }
    if (c === 96) { // `
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out += escapeHtml(s.slice(plain, j));
        out += '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>';
        i = k + 1; plain = i; continue;
      }
      i = j + 1; continue; // literal backtick: plain
    }
    if (c === 42) { // *
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out += escapeHtml(s.slice(plain, j));
          out += '<strong>' + inline(s.slice(j + 2, k), env) + '</strong>';
          i = k + 2; plain = i; continue;
        }
        i = j + 2; continue; // literal **: plain
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out += escapeHtml(s.slice(plain, j));
        out += '<em>' + inline(s.slice(j + 1, k), env) + '</em>';
        i = k + 1; plain = i; continue;
      }
      i = j + 1; continue; // literal *: plain
    }
    // c === 91: [
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      if (j > plain) out += escapeHtml(s.slice(plain, j));
      out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(j + 1, k), env) + '</a>';
      i = mm + 1; plain = i; continue;
    }
    i = j + 1; continue; // literal [: plain
  }
  if (plain < N) out += escapeHtml(s.slice(plain, N));
  return out;
}

/** `src` rendered: HTML, table of contents (level 2 and 3 headings), excerpt (first paragraph). */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const tokens = lex(src);
  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        blocks.push(`<pre><code${cls}>${t.lines.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        blocks.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ============================================================ templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
const STANDALONE = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const N = src.length;
  while (i < N) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === N - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? N : nl;
    const standalone = STANDALONE.test(src.slice(lineStart, open)) && STANDALONE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? N : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { k: 6, body: [] }; // 6 = root
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, text: tok.text });
    else if (tok.t === 'var') body.push({ k: 1, path: tok.path });
    else if (tok.t === 'raw') body.push({ k: 2, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { k: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 6 ? parent.body : parent.k === 4 ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  return '';
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.k) {
      case 0: out += n.text; break;
      case 1: out += ctx.escape(textOf(lookup(scope, n.path))); break;
      case 2: out += textOf(lookup(scope, n.path)); break;
      case 3: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 4: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const name = n.name, bodyNodes = n.body, len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          out += renderNodes(bodyNodes, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ============================================================ build pipeline

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  // ---- templates (parse in code-unit order of name)
  const templates = new Map();
  const report = [];
  const tnames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tnames.length; i++) {
    const name = tnames[i];
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // ---- 1. sources (sorted by path), statics
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // ---- 2. front matter
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // ---- 3. permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    let t = taken.get(dir);
    if (t === undefined) { t = new Set(dir === '' ? RESERVED : []); taken.set(dir, t); }
    return t;
  };
  const bySource = new Map();
  const slugCache = new Map();
  const slugOf = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) { v = slugify(text); slugCache.set(text, v); }
    return v;
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // ---- 4. markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // ---- 5. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // ---- 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugOf(tags[i]);
      if (!seen.has(slug)) { seen.add(slug); out.push(tags[i]); }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s);
    const refs = new Array(names.length);
    for (let j = 0; j < names.length; j++) {
      const slug = slugOf(names[j]);
      let tag = bySlug.get(slug);
      if (tag === undefined) tag = { name: names[j], slug, url: '', posts: [] };
      refs[j] = tag;
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // ---- 7. layouts
  const rmOf = (s) => {
    let rm = s._rm;
    if (rm === undefined) {
      const m = s.body.match(/\S+/g);
      rm = Math.max(1, Math.ceil((m === null ? 0 : m.length) / 200));
      s._rm = rm;
    }
    return rm;
  };
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: rmOf(s),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentN = input.site.recent;
  const recent = posts.slice(0, recentN).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const output = {};

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const page = {
      title: s.data.title, url: s.url, date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '', excerpt: s.excerpt,
      reading_minutes: rmOf(s),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = renderNodes(templates.get(s.layout), { vars: { site, tags: allTags, recent, page }, parent: null }, ctx, 0);
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexTpl = templates.get('index');
  if (indexTpl !== undefined) {
    for (let k = 1; k <= pages; k++) {
      const html = renderNodes(indexTpl, {
        vars: {
          site, tags: allTags, recent,
          posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
          pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
        }, parent: null,
      }, ctx, 0);
      output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
  }
  const tagTpl = templates.get('tag');
  if (tagTpl !== undefined) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const html = renderNodes(tagTpl, {
        vars: { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } }, parent: null,
      }, ctx, 0);
      output[`tags/${t.slug}/index.html`] = html;
    }
  }
  const tagsTpl = templates.get('tags');
  if (tagsTpl !== undefined) output['tags/index.html'] = renderNodes(tagsTpl, { vars: { site, tags: allTags, recent }, parent: null }, ctx, 0);

  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // ---- 8. report
  const lines = report.concat([...broken]).sort(byCodeUnits);
  const pageCount = kept.length - posts.length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}