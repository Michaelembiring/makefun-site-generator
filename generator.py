#!/usr/bin/env python3
"""
generator.py — a static site generator that mirrors make.fun's makefun-site 1.0.0.

This is a faithful Python port of the same pipeline implemented in solve.js (the
actual bounty entry). NOTE: the site-generator-speed-01 bounty harness runs
`node /bot/main.ts` and only accepts JavaScript/TypeScript, so the *graded*
drop-in is solve.js. This file is the Python reference: `build(input)` returns the
same output tree (a dict of path -> text) for a site config, and the __main__
reads a JSON config and prints the JSON output tree.

Usage:
    python3 generator.py config.json            # prints JSON object of path -> text
    python3 generator.py config.json out.json   # writes it to out.json

For ASCII inputs the output is byte-for-byte identical to makefun-site 1.0.0.
"""

import sys
import json
import re
import unicodedata

# ============================================================ text rules

_ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}
_ESC_RE = re.compile(r'[&<>"\']')
_SLUG_MAX = 64
_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
           'August', 'September', 'October', 'November', 'December']


def escape_html(text):
    if not _ESC_RE.search(text):
        return text
    return _ESC_RE.sub(lambda m: _ESCAPES[m.group(0)], text)


def slugify(text):
    # NFKD, drop combining marks
    plain = ''.join(c for c in unicodedata.normalize('NFKD', text)
                    if not unicodedata.category(c).startswith('M'))
    out = []
    gap = False
    for ch in plain:
        if 'A' <= ch <= 'Z':
            keep = ch.lower()
        elif ('a' <= ch <= 'z') or ('0' <= ch <= '9'):
            keep = ch
        else:
            keep = None
        if keep is None:
            gap = len(out) > 0
            continue
        if gap:
            out.append('-')
            gap = False
        out.append(keep)
    s = ''.join(out)
    if len(s) > _SLUG_MAX:
        s = s[:_SLUG_MAX].rstrip('-')
    return s if s != '' else 'untitled'


def unique_slug(slug, taken):
    out = slug
    n = 2
    while out in taken:
        out = '%s-%d' % (slug, n)
        n += 1
    taken.add(out)
    return out


def long_date(date):
    y = date[0:4]
    m = int(date[5:7])
    d = int(date[8:10])
    return '%d %s %s' % (d, _MONTHS[m - 1], y)


# ============================================================ front matter

_KEYS = {'title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'}
_LINE = re.compile(r'^([a-z_]+):(?: (.*))?$')
_DATE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})$')
_NAME = re.compile(r'^[a-z0-9-]+$')
_SLUGRE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
_TAG = re.compile(r'^[^"[\]]+$')
_BLANKLINE = re.compile(r'^[ \t]*$')


def _days_in(y, m):
    if m == 2:
        return 29 if (y % 4 == 0 and y % 100 != 0) or y % 400 == 0 else 28
    return 30 if m in (4, 6, 9, 11) else 31


def _string_of(raw):
    if raw.startswith('"'):
        if len(raw) < 2 or not raw.endswith('"'):
            return {'error': 'a quoted string is not closed'}
        out = []
        i = 1
        while i < len(raw) - 1:
            c = raw[i]
            if c == '\\':
                n = raw[i + 1] if i + 1 < len(raw) else ''
                if (n != '"' and n != '\\') or i + 1 == len(raw) - 1:
                    return {'error': 'a quoted string holds an escape other than \\" or \\\\'}
                out.append(n)
                i += 2
                continue
            elif c == '"':
                return {'error': 'a quoted string holds a stray quote'}
            else:
                out.append(c)
            i += 1
        return {'value': ''.join(out)}
    if raw.startswith('['):
        return {'error': 'a bare string opens on ['}
    return {'value': raw}


def _value_of(key, raw):
    if key in ('title', 'summary'):
        s = _string_of(raw)
        return {'error': 'key "%s": %s' % (key, s['error'])} if 'error' in s else s
    if key == 'date':
        m = _DATE.match(raw)
        y = int(m.group(1)) if m else 0
        mo = int(m.group(2)) if m else 0
        d = int(m.group(3)) if m else 0
        if not m or y < 1970 or y > 2099 or mo < 1 or mo > 12 or d < 1 or d > _days_in(y, mo):
            return {'error': 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)'}
        return {'value': raw}
    if key == 'tags':
        if not raw.startswith('[') or not raw.endswith(']'):
            return {'error': 'key "tags": not a list [a, b]'}
        inner = raw[1:-1]
        if inner.strip() == '':
            return {'value': []}
        tags = [t.strip() for t in inner.split(',')]
        if any(t == '' or not _TAG.match(t) for t in tags):
            return {'error': 'key "tags": an empty tag, or one holding " [ or ]'}
        return {'value': tags}
    if key == 'draft':
        if raw == 'true':
            return {'value': True}
        if raw == 'false':
            return {'value': False}
        return {'error': 'key "draft": true or false'}
    if key == 'layout':
        return {'value': raw} if _NAME.match(raw) else {'error': 'key "layout": not a template name'}
    if key == 'slug':
        return {'value': raw} if _SLUGRE.match(raw) and len(raw) <= 64 else {'error': 'key "slug": not a slug'}
    return {'error': 'unknown key "%s"' % key}


def parse_front_matter(text):
    lines = text.split('\n')
    if lines[0] != '---':
        return {'error': 'no front matter'}
    close = -1
    for i in range(1, len(lines)):
        if lines[i] == '---':
            close = i
            break
    if close == -1:
        return {'error': 'the front matter is not closed'}
    data = {}
    for i in range(1, close):
        line = lines[i]
        if _BLANKLINE.match(line) or line.startswith('#'):
            continue
        m = _LINE.match(line)
        if not m:
            return {'error': 'line %d is not "key: value"' % (i + 1)}
        key = m.group(1)
        raw = (m.group(2) or '').rstrip(' \t')
        if key not in _KEYS:
            return {'error': 'unknown key "%s"' % key}
        if key in data:
            return {'error': 'key "%s" is given twice' % key}
        if raw == '':
            return {'error': 'key "%s" has no value' % key}
        v = _value_of(key, raw)
        if 'error' in v:
            return v
        data[key] = v['value']
    if 'title' not in data:
        return {'error': 'no title'}
    return {'data': data, 'body': '\n'.join(lines[close + 1:])}


# ============================================================ markdown

_M_BLANK = re.compile(r'^[ \t]*$')
_FENCE_OPEN = re.compile(r'^```([A-Za-z0-9_+-]*)[ \t]*$')
_FENCE_CLOSE = re.compile(r'^```[ \t]*$')
_HEADING = re.compile(r'^(#{1,6})[ \t]+(.*?)[ \t]*$')
_HR = re.compile(r'^(?:---|\*\*\*)[ \t]*$')
_QUOTE = re.compile(r'^>')
_BULLET = re.compile(r'^[-*] (.*)$')
_ORDERED = re.compile(r'^(\d{1,9})\. (.*)$')
_CONTINUED = re.compile(r'^ {2,}\S')
_TRIMLINE = re.compile(r'^[ \t]+|[ \t]+$')


def _heading_of(line):
    m = _HEADING.match(line)
    return None if m is None or m.group(2) == '' else {'depth': len(m.group(1)), 'text': m.group(2)}


def _ends_paragraph(line):
    return bool(_M_BLANK.match(line) or _FENCE_OPEN.match(line) or _HEADING.match(line) or _HR.match(line))


def _trim_line(line):
    return _TRIMLINE.sub('', line)


def _lex(src):
    lines = src.split('\n')
    tokens = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if _M_BLANK.match(line):
            i += 1
            continue
        fence = _FENCE_OPEN.match(line)
        if fence:
            body = []
            i += 1
            while i < n and not _FENCE_CLOSE.match(lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            tokens.append({'type': 'code', 'lang': fence.group(1), 'lines': body})
            continue
        heading = _heading_of(line)
        if heading is not None:
            tokens.append({'type': 'heading', 'depth': heading['depth'], 'text': heading['text']})
            i += 1
            continue
        if _HR.match(line):
            tokens.append({'type': 'hr'})
            i += 1
            continue
        if _QUOTE.match(line):
            body = []
            while i < n and _QUOTE.match(lines[i]):
                body.append(re.sub(r'^> ?', '', lines[i]))
                i += 1
            tokens.append({'type': 'blockquote', 'lines': [x for x in map(_trim_line, body) if x != '']})
            continue
        bullet = _BULLET.match(line)
        ordered = None if bullet else _ORDERED.match(line)
        if bullet or ordered:
            is_ordered = ordered is not None
            marker = _ORDERED if is_ordered else _BULLET
            items = []
            while i < n:
                m = marker.match(lines[i])
                if m:
                    items.append([_trim_line(m.group(2) if is_ordered else m.group(1))])
                    i += 1
                elif _CONTINUED.match(lines[i]):
                    items[-1].append(_trim_line(lines[i]))
                    i += 1
                else:
                    break
            tokens.append({'type': 'list', 'ordered': is_ordered,
                           'start': int(ordered.group(1)) if is_ordered else 1,
                           'items': ['\n'.join(p) for p in items]})
            continue
        body = [_trim_line(line)]
        i += 1
        while i < n and not _ends_paragraph(lines[i]):
            body.append(_trim_line(lines[i]))
            i += 1
        tokens.append({'type': 'paragraph', 'text': '\n'.join(body)})
    return tokens


_ESCAPABLE = set('\\`*_[]()#+-.!>')
_WS_RE = re.compile(r'\s')


def _find_unescaped(s, what, frm):
    j = frm
    while j <= len(s) - len(what):
        if s[j] == '\\' and j + 1 < len(s) and s[j + 1] in _ESCAPABLE:
            j += 2
            continue
        if s.startswith(what, j):
            return j
        j += 1
    return -1


def _find_single_star(s, frm):
    j = frm
    while j < len(s):
        c = s[j]
        if c == '\\' and j + 1 < len(s) and s[j + 1] in _ESCAPABLE:
            j += 2
            continue
        if c != '*':
            j += 1
            continue
        if j + 1 < len(s) and s[j + 1] == '*':
            j += 2
            continue
        return j
    return -1


def _inline(s, env):
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == '\\' and i + 1 < n and s[i + 1] in _ESCAPABLE:
            out.append(escape_html(s[i + 1]))
            i += 2
            continue
        if c == '`':
            j = s.find('`', i + 1)
            if j > i + 1:
                out.append('<code>' + escape_html(s[i + 1:j]) + '</code>')
                i = j + 1
            else:
                out.append('`')
                i += 1
            continue
        if c == '*':
            if i + 1 < n and s[i + 1] == '*':
                j = _find_unescaped(s, '**', i + 2)
                if j > i + 2:
                    out.append('<strong>' + _inline(s[i + 2:j], env) + '</strong>')
                    i = j + 2
                else:
                    out.append('**')
                    i += 2
                continue
            j = _find_single_star(s, i + 1)
            if j > i + 1:
                out.append('<em>' + _inline(s[i + 1:j], env) + '</em>')
                i = j + 1
            else:
                out.append('*')
                i += 1
            continue
        if c == '[':
            k = _find_unescaped(s, ']', i + 1)
            m = s.find(')', k + 2) if (k != -1 and k + 1 < n and s[k + 1] == '(') else -1
            target = '' if m == -1 else s[k + 2:m]
            if target != '' and not _WS_RE.search(target):
                out.append('<a href="' + escape_html(env['link'](target)) + '">' + _inline(s[i + 1:k], env) + '</a>')
                i = m + 1
                continue
            out.append('[')
            i += 1
            continue
        out.append(escape_html(c))
        i += 1
    return ''.join(out)


def _render_markdown(src, env):
    ids = set()
    blocks = []
    toc = []
    excerpt = None
    for t in _lex(src):
        ty = t['type']
        if ty == 'heading':
            _id = unique_slug(slugify(t['text']), ids)
            html = _inline(t['text'], env)
            blocks.append('<h%d id="%s">%s</h%d>' % (t['depth'], _id, html, t['depth']))
            if t['depth'] in (2, 3):
                toc.append({'level': t['depth'], 'id': _id, 'html': html})
        elif ty == 'code':
            cls = '' if t['lang'] == '' else ' class="language-%s"' % escape_html(t['lang'])
            blocks.append('<pre><code%s>%s</code></pre>' % (cls, ''.join(escape_html(l) + '\n' for l in t['lines'])))
        elif ty == 'hr':
            blocks.append('<hr>')
        elif ty == 'blockquote':
            if len(t['lines']) == 0:
                blocks.append('<blockquote>\n</blockquote>')
            else:
                blocks.append('<blockquote>\n<p>' + _inline('\n'.join(t['lines']), env) + '</p>\n</blockquote>')
        elif ty == 'list':
            tag = 'ol' if t['ordered'] else 'ul'
            open_tag = '<ol start="%d">' % t['start'] if (t['ordered'] and t['start'] != 1) else '<%s>' % tag
            blocks.append(open_tag + '\n' + ''.join('<li>' + _inline(item, env) + '</li>\n' for item in t['items']) + '</%s>' % tag)
        elif ty == 'paragraph':
            html = _inline(t['text'], env)
            if excerpt is None:
                excerpt = html
            blocks.append('<p>' + html + '</p>')
    return {'html': ''.join(b + '\n' for b in blocks), 'toc': toc, 'excerpt': excerpt or ''}


# ============================================================ templates

_INCLUDE_DEPTH = 8
_PATH = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$')
_FOR = re.compile(r'^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$')
_IF = re.compile(r'^if (not )?(\S+)$')
_INCLUDE = re.compile(r'^include "([a-z0-9-]+)"$')
_STANDALONE = re.compile(r'^[ \t]*$')


class TemplateError(Exception):
    pass


def _path_of(name, text):
    if not _PATH.match(text):
        raise TemplateError('template "%s": %s is not a path' % (name, json.dumps(text)))
    return text.split('.')


def _tokenize(name, src):
    tokens = []
    text = ''
    i = 0
    n = len(src)
    while i < n:
        open_ = src.find('{', i)
        if open_ == -1 or open_ == n - 1:
            text += src[i:]
            break
        nxt = src[open_ + 1]
        if nxt != '{' and nxt != '%':
            text += src[i:open_ + 1]
            i = open_ + 1
            continue
        text += src[i:open_]
        if nxt == '{':
            raw = open_ + 2 < n and src[open_ + 2] == '{'
            close = src.find('}}}' if raw else '}}', open_ + (3 if raw else 2))
            if close == -1:
                raise TemplateError('template "%s": a %s is not closed' % (name, '{{{' if raw else '{{'))
            if text != '':
                tokens.append({'t': 'text', 'text': text})
            text = ''
            tokens.append({'t': 'raw' if raw else 'var', 'path': _path_of(name, src[open_ + (3 if raw else 2):close].strip())})
            i = close + (3 if raw else 2)
            continue
        close = src.find('%}', open_ + 2)
        if close == -1:
            raise TemplateError('template "%s": a {%% is not closed' % name)
        end = close + 2
        line_start = src.rfind('\n', 0, open_) + 1
        nl = src.find('\n', end)
        line_end = n if nl == -1 else nl
        standalone = bool(_STANDALONE.match(src[line_start:open_]) and _STANDALONE.match(src[end:line_end]))
        if standalone:
            text = text[:len(text) - (open_ - line_start)]
        if text != '':
            tokens.append({'t': 'text', 'text': text})
        text = ''
        tokens.append({'t': 'tag', 'tag': src[open_ + 2:close].strip()})
        i = (n if nl == -1 else nl + 1) if standalone else end
    if text != '':
        tokens.append({'t': 'text', 'text': text})
    return tokens


def parse_template(name, src):
    root = {'kind': 'root', 'body': []}
    stack = [root]
    body = root['body']

    def cur():
        return stack[-1]

    for tok in _tokenize(name, src):
        if tok['t'] == 'text':
            body.append({'kind': 'text', 'text': tok['text']})
        elif tok['t'] in ('var', 'raw'):
            body.append({'kind': tok['t'], 'path': tok['path']})
        else:
            tag = tok['tag']
            top = cur()
            m = _FOR.match(tag)
            if m:
                node = {'kind': 'for', 'name': m.group(1), 'path': _path_of(name, m.group(2)), 'body': []}
                body.append(node)
                stack.append(node)
                body = node['body']
                continue
            m = _IF.match(tag)
            if m:
                node = {'kind': 'if', 'not': m.group(1) is not None, 'path': _path_of(name, m.group(2)), 'then': [], 'else': None}
                body.append(node)
                stack.append(node)
                body = node['then']
                continue
            if tag == 'else':
                if top['kind'] != 'if' or top['else'] is not None:
                    raise TemplateError('template "%s": an else outside an if' % name)
                top['else'] = []
                body = top['else']
                continue
            if tag in ('endfor', 'endif'):
                want = 'for' if tag == 'endfor' else 'if'
                if top['kind'] != want:
                    raise TemplateError('template "%s": an %s with no open %s' % (name, tag, tag[3:]))
                stack.pop()
                parent = cur()
                body = parent['body'] if parent['kind'] in ('root', 'for') else (parent['else'] if parent['else'] is not None else parent['then'])
                continue
            m = _INCLUDE.match(tag)
            if m:
                body.append({'kind': 'include', 'name': m.group(1)})
                continue
            raise TemplateError('template "%s": {%% %s %%} is not a tag' % (name, tag))
    if len(stack) > 1:
        raise TemplateError('template "%s": a %s is not closed' % (name, cur()['kind']))
    return root['body']


def _lookup(scope, path):
    s = scope
    while s is not None and path[0] not in s['vars']:
        s = s['parent']
    if s is None:
        return None
    v = s['vars'][path[0]]
    for k in range(1, len(path)):
        if v is None or not isinstance(v, (dict, list)) or path[k] not in v:
            return None
        v = v[path[k]]
    return v


def _text_of(v):
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return str(int(v)) if float(v).is_integer() else str(v)
    if isinstance(v, list):
        return ', '.join(_text_of(x) for x in v)
    return ''


def _truthy(v):
    if isinstance(v, list):
        return len(v) > 0
    return v is not None and v is not False and v != '' and v != 0


def _render_nodes(nodes, scope, ctx, depth):
    out = []
    for node in nodes:
        k = node['kind']
        if k == 'text':
            out.append(node['text'])
        elif k == 'var':
            out.append(ctx['escape'](_text_of(_lookup(scope, node['path']))))
        elif k == 'raw':
            out.append(_text_of(_lookup(scope, node['path'])))
        elif k == 'if':
            v = _truthy(_lookup(scope, node['path']))
            branch = node['then'] if (v != node['not']) else node['else']
            if branch is not None:
                out.append(_render_nodes(branch, scope, ctx, depth))
        elif k == 'for':
            xs = _lookup(scope, node['path'])
            if not isinstance(xs, list):
                continue
            for idx, x in enumerate(xs):
                vars_ = {node['name']: x, 'loop': {'index': idx + 1, 'first': idx == 0, 'last': idx == len(xs) - 1, 'length': len(xs)}}
                out.append(_render_nodes(node['body'], {'vars': vars_, 'parent': scope}, ctx, depth))
        elif k == 'include':
            t = ctx['templates'].get(node['name'])
            if t is not None and depth < _INCLUDE_DEPTH:
                out.append(_render_nodes(t, scope, ctx, depth + 1))
    return ''.join(out)


# ============================================================ build pipeline

_REPORT_FILE = 'build-report.txt'
_RESERVED = ['posts', 'tags', 'page']


def _dir_of(path):
    return path[:path.rfind('/')] if '/' in path else ''


def _resolve_path(dir_, rel):
    parts = [] if dir_ == '' else dir_.split('/')
    for seg in rel.split('/'):
        if seg == '' or seg == '.':
            continue
        if seg == '..':
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(seg)
    return '/'.join(parts)


def build(input):
    templates = {}
    report = []
    for name in sorted(input['templates'].keys()):
        try:
            templates[name] = parse_template(name, input['templates'][name])
        except TemplateError as err:
            report.append(str(err))

    base = re.sub(r'/+$', '', input['site']['base_url'])

    # 1. sources
    files = sorted(input['files'], key=lambda f: f['path'])
    sources = []
    statics = []
    for f in files:
        if f['path'].endswith('.md'):
            sources.append({'path': f['path'], 'text': re.sub(r'\r\n?', '\n', f['content'])})
        else:
            statics.append({'path': f['path'], 'content': f['content']})

    # 2. front matter
    kept = []
    for s in sources:
        fm = parse_front_matter(s['text'])
        if 'error' in fm:
            report.append('refused %s: %s' % (s['path'], fm['error']))
            continue
        s['data'] = fm['data']
        s['body'] = fm['body']
        s['post'] = s['path'].startswith('posts/')
        own = next((d for d in _RESERVED if d != 'posts' and s['path'].startswith(d + '/')), None)
        if own is not None:
            report.append("refused %s: %s/ is the generator's own" % (s['path'], own))
            continue
        if s['post'] and 'date' not in s['data']:
            report.append('refused %s: a post needs a date' % s['path'])
            continue
        layout = s['data'].get('layout', 'post' if s['post'] else 'page')
        if layout not in templates:
            report.append('refused %s: layout "%s" is no template that parses' % (s['path'], layout))
            continue
        s['layout'] = layout
        if s['data'].get('draft') is True:
            report.append('draft %s' % s['path'])
            continue
        kept.append(s)

    # 3. permalinks
    taken = {}

    def taken_in(d):
        if d not in taken:
            taken[d] = set(_RESERVED if d == '' else [])
        return taken[d]

    by_source = {}
    slug_cache = {}

    def slug_of(text):
        if text not in slug_cache:
            slug_cache[text] = slugify(text)
        return slug_cache[text]

    for s in kept:
        d = 'posts' if s['post'] else _dir_of(s['path'])
        slug = unique_slug(s['data']['slug'] if 'slug' in s['data'] else slug_of(s['data']['title']), taken_in(d))
        s['slug'] = slug
        s['outDir'] = slug if d == '' else d + '/' + slug
        s['url'] = base + '/' + s['outDir'] + '/'
        by_source[s['path']] = s

    # 4. markdown
    static_paths = set(f['path'] for f in statics)
    broken = set()
    for s in kept:
        d = _dir_of(s['path'])

        def link(target, s=s, d=d):
            if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', target) or target.startswith('/') or target.startswith('#'):
                return target
            hash_ = target.find('#')
            rel = target if hash_ == -1 else target[:hash_]
            frag = '' if hash_ == -1 else target[hash_:]
            path = None if rel == '' else _resolve_path(d, rel)
            if path is not None and path in by_source:
                return by_source[path]['url'] + frag
            if path is not None and path in static_paths:
                return base + '/' + path + frag
            broken.add('broken-link %s -> %s' % (s['path'], target))
            return target

        md = _render_markdown(s['body'], {'link': link})
        s['html'] = md['html']
        s['toc'] = md['toc']
        s['excerpt'] = md['excerpt']

    # 5. collections
    posts = [s for s in kept if s['post']]
    posts.sort(key=lambda s: s['slug'])
    posts.sort(key=lambda s: s['data']['date'], reverse=True)  # stable: date desc, then slug asc
    for k, p in enumerate(posts):
        p['newer'] = None if k == 0 else posts[k - 1]
        p['older'] = None if k == len(posts) - 1 else posts[k + 1]

    # 6. tags
    by_slug = {}

    def own_tags(s):
        seen = set()
        out = []
        for name in s['data'].get('tags', []):
            slug = slug_of(name)
            if slug not in seen:
                seen.add(slug)
                out.append(name)
        return out

    for p in posts:
        p['tagRefs'] = []
        for name in own_tags(p):
            slug = slug_of(name)
            if slug not in by_slug:
                by_slug[slug] = {'name': name, 'slug': slug, 'url': base + '/tags/' + slug + '/', 'posts': []}
            tag = by_slug[slug]
            tag['posts'].append(p)
            p['tagRefs'].append(tag)
    for s in kept:
        if s['post']:
            continue
        refs = []
        for name in own_tags(s):
            slug = slug_of(name)
            tag = by_slug.get(slug)
            if tag is None:
                tag = {'name': name, 'slug': slug, 'url': '', 'posts': []}
            refs.append(tag)
        s['tagRefs'] = refs
    tags = sorted(by_slug.values(), key=lambda t: t['slug'])
    tags.sort(key=lambda t: len(t['posts']), reverse=True)

    # 7. layouts
    def rm_of(s):
        if '_rm' not in s:
            words = re.findall(r'\S+', s['body'])
            s['_rm'] = max(1, -(-len(words) // 200))
        return s['_rm']

    def card_of(s):
        return {
            'title': s['data']['title'], 'url': s['url'],
            'date': s['data'].get('date', ''),
            'date_long': '' if 'date' not in s['data'] else long_date(s['data']['date']),
            'summary': s['data'].get('summary', ''), 'excerpt': s['excerpt'],
            'reading_minutes': rm_of(s),
            'tags': [{'name': t['name'], 'slug': t['slug'], 'url': t['url']} for t in s['tagRefs']],
        }

    cards = {id(p): card_of(p) for p in posts}
    site = {'title': input['site']['title'], 'base_url': base}
    all_tags = [{'name': t['name'], 'slug': t['slug'], 'url': t['url'], 'count': len(t['posts'])} for t in tags]
    recent = [cards[id(p)] for p in posts[:input['site']['recent']]]
    ctx = {'templates': templates, 'escape': escape_html}
    output = {}

    def link_of(s):
        if s is None:
            return None
        return {'title': s['data']['title'], 'url': s['url'], 'date': s['data'].get('date', ''),
                'date_long': '' if 'date' not in s['data'] else long_date(s['data']['date'])}

    def render(name, vars_):
        nodes = templates.get(name)
        return None if nodes is None else _render_nodes(nodes, {'vars': dict({'site': site, 'tags': all_tags, 'recent': recent}, **vars_), 'parent': None}, ctx, 0)

    for s in kept:
        page = card_of(s)
        page.update({
            'slug': s['slug'], 'content': s['html'],
            'toc': [{'level': h['level'], 'id': h['id'], 'html': h['html']} for h in s['toc']],
            'newer': link_of(s.get('newer')), 'older': link_of(s.get('older')), 'is_post': s['post'],
        })
        output[s['outDir'] + '/index.html'] = render(s['layout'], {'page': page})

    per = input['site']['per_page']
    pages = max(1, -(-len(posts) // per))

    def index_url(k):
        return base + '/' if k == 1 else base + '/page/%d/' % k

    for k in range(1, pages + 1):
        html = render('index', {
            'posts': [cards[id(p)] for p in posts[(k - 1) * per:k * per]],
            'pager': {'number': k, 'total': pages, 'url': index_url(k),
                      'newer_url': '' if k == 1 else index_url(k - 1),
                      'older_url': '' if k == pages else index_url(k + 1)},
        })
        if html is not None:
            output['index.html' if k == 1 else 'page/%d/index.html' % k] = html
    for t in tags:
        html = render('tag', {'tag': {'name': t['name'], 'slug': t['slug'], 'url': t['url'], 'count': len(t['posts']),
                                      'posts': [cards[id(p)] for p in t['posts']]}})
        if html is not None:
            output['tags/%s/index.html' % t['slug']] = html
    tags_html = render('tags', {})
    if tags_html is not None:
        output['tags/index.html'] = tags_html

    for f in statics:
        if f['path'] in output:
            report.append('shadowed %s: a built page has its path' % f['path'])
        else:
            output[f['path']] = f['content']

    # 8. report
    lines = sorted(report + list(broken))
    page_count = len(kept) - len(posts)
    lines.append('built %d pages, %d posts, %d tags and %d static files' % (page_count, len(posts), len(tags), len(statics)))
    output[_REPORT_FILE] = '\n'.join(lines) + '\n'
    return output


def main(argv):
    if len(argv) < 2:
        print('usage: generator.py <config.json> [out.json]', file=sys.stderr)
        return 2
    with open(argv[1], 'r', encoding='utf-8') as f:
        config = json.load(f)
    result = build(config)
    text = json.dumps(result, ensure_ascii=False)
    if len(argv) >= 3:
        with open(argv[2], 'w', encoding='utf-8') as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))