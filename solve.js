// site-generator-speed v2: a fast drop-in for makefun-site 1.0.0.
// Hand-written from the spec (README) and the reference's observable rules:
// same answers on every case, much less CPU. No imports: one module, and
// the hot paths (Markdown inline, escaping, slug, word count, templates)
// are written to do the least work per byte.
//
// Entry: run(input) -> { path: text } for one case's { site, templates, files }.

/** A template that does not parse: its name and why (goes in the report). */
class TemplateError extends Error {}

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ASCII_ONLY = /^[\x00-\x7F]*$/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure ASCII text is unchanged by NFKD and holds no combining marks,
 * so it skips the normalise pass.
 */
function slugify(text) {
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const p = date.split('-');
  return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}`;
}

/** Whether a UTF-16 code unit is a JS \s whitespace character. */
function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else {
      ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
        c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    }
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The directory of a "/"-separated path ("" at the root). */
function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------------- front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked
 * with indexOf so the body is never split.
 */
function parseFrontMatter(text) {
  let i = 0;
  let nl = text.indexOf('\n', 0);
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  i = nl === -1 ? text.length : nl + 1;
  let lineNo = 2;
  let closeAt = -1;
  let closeLine = -1;
  while (i <= text.length) {
    nl = text.indexOf('\n', i);
    const line = nl === -1 ? text.slice(i) : text.slice(i, nl);
    if (line === '---') {
      closeAt = nl === -1 ? text.length : nl + 1;
      closeLine = lineNo;
      break;
    }
    if (nl === -1) break;
    i = nl + 1;
    lineNo++;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  i = text.indexOf('\n', 0) + 1;
  lineNo = 2;
  while (lineNo < closeLine) {
    nl = text.indexOf('\n', i);
    const line = nl === -1 ? text.slice(i) : text.slice(i, nl);
    if (/^[ \t]*$/.test(line) || line[0] === '#') {
      // Blank or comment: skipped.
    } else {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    i = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeAt) };
}

// ---------------------------------------------------------------- Markdown

/** A slug from the per-case cache (tag names and headings repeat a lot). */
function slugCached(cache, text) {
  let s = cache.get(text);
  if (s === undefined) {
    s = slugify(text);
    cache.set(text, s);
  }
  return s;
}

/** Whether a line is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence-open line's language, or null (three backticks, an optional language, spaces/tabs only). */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

/** Whether a line closes a fence (three backticks, spaces/tabs after them). */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(n + 1));
  return text === '' ? null : { depth: n, text };
}

/** Whether a line is a thematic break (--- or ***, spaces/tabs only after). */
function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const a = line.charCodeAt(0);
  if (a === 32 || a === 9) return isBlank(line);
  if (a === 35) return headingOf(line) !== null;
  if (a === 96) return fenceOpen(line) !== null;
  if (a === 45 || a === 42) return isHR(line);
  return false;
}

/** A list item's kind and start, or null. Bullet first, then ordered (1-9 digits, ". "). */
function listStart(line) {
  const a = line.charCodeAt(0);
  if ((a === 45 || a === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1 };
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, d)) };
  }
  return null;
}

/** A bullet item's text, or null. */
function bulletText(line) {
  const a = line.charCodeAt(0);
  if ((a === 45 || a === 42) && line.charCodeAt(1) === 32) return trimLine(line.slice(2));
  return null;
}

/** An ordered item's text, or null. */
function orderedText(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) return trimLine(line.slice(d + 2));
  return null;
}

/** Whether a line continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isWSCode(line.charCodeAt(i));
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether a string holds any character inline would act on (a construct starter or an escapable character). */
const INLINE_TEST = /[\\`*\[&<>"']/;

/**
 * `s` rendered inline; `link(target)` is a link's href. A single regex
 * jumps from one interesting character to the next, so the plain text
 * between them is pushed raw (it holds no escapable character and no
 * construct starter) and no per-character escaping ever runs. A nested
 * span whose text holds nothing interesting is pushed raw, not re-rendered.
 */
function inline(s, link) {
  const out = [];
  const re = /[\\`*\[&<>"']/g;
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (j > i) out.push(s.slice(i, j));
    if (c === '&') {
      out.push('&amp;');
      i = j + 1;
    } else if (c === '<') {
      out.push('&lt;');
      i = j + 1;
    } else if (c === '>') {
      out.push('&gt;');
      i = j + 1;
    } else if (c === '"') {
      out.push('&quot;');
      i = j + 1;
    } else if (c === "'") {
      out.push('&#39;');
      i = j + 1;
    } else if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        const e = s[j + 1];
        out.push(e === '>' ? '&gt;' : e);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          const inner = s.slice(j + 2, k);
          out.push('<strong>', INLINE_TEST.test(inner) ? inline(inner, link) : inner, '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          const inner = s.slice(j + 1, k);
          out.push('<em>', INLINE_TEST.test(inner) ? inline(inner, link) : inner, '</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else {
      // '[': a link, or itself when the target is not a good one.
      const k = findUnescaped(s, ']', j + 1);
      const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !/\s/.test(target)) {
        const inner = s.slice(j + 1, k);
        out.push('<a href="', escapeHtml(link(target)), '">', INLINE_TEST.test(inner) ? inline(inner, link) : inner, '</a>');
        i = q + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
    re.lastIndex = i;
  }
  if (i < s.length) out.push(s.slice(i));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or ""). Blocks are rendered straight
 * from the lines, with no token objects in between; the dispatch reads each
 * line's first character, so most lines take one test to reach their block.
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const a = line.length === 0 ? -1 : line.charCodeAt(0);
    if (a === -1) {
      i++;
      continue;
    }
    if (a === 32 || a === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // An indented non-blank line is a paragraph line: fences, headings,
      // breaks, quotes and lists all need column 0.
    } else if (a === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${lang}"`;
        blocks.push(`<pre><code${cls}>${body.length ? `${escapeHtml(body.join('\n'))}\n` : ''}</code></pre>`);
        continue;
      }
    } else if (a === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugCached(slugCache, heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (a === 45 || a === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const ls = listStart(line);
      if (ls !== null) {
        const items = [];
        while (i < n) {
          const t = ls.ordered ? orderedText(lines[i]) : bulletText(lines[i]);
          if (t !== null) {
            items.push([t]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = ls.ordered ? 'ol' : 'ul';
        const open = ls.ordered && ls.start !== 1 ? `<ol start="${ls.start}">` : `<${tag}>`;
        let h = `${open}\n`;
        for (const it of items) h += `<li>${inline(it.join('\n'), link)}</li>\n`;
        h += `</${tag}>`;
        blocks.push(h);
        continue;
      }
    } else if (a === 62) {
      const raw = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        raw.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (const b of raw) {
        const t = trimLine(b);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    } else if (a >= 48 && a <= 57) {
      const ls = listStart(line);
      if (ls !== null) {
        const items = [];
        while (i < n) {
          const t = orderedText(lines[i]);
          if (t !== null) {
            items.push([t]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const open = ls.start !== 1 ? `<ol start="${ls.start}">` : '<ol>';
        let h = `${open}\n`;
        for (const it of items) h += `<li>${inline(it.join('\n'), link)}</li>\n`;
        h += '</ol>';
        blocks.push(h);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length ? `${blocks.join('\n')}\n` : '', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
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
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not
 * parse). Kinds: 0 text, 1 var, 2 raw, 3 for, 4 if, 5 include.
 */
function parseTpl(name, src) {
  const root = { k: -1, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, t: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { k: 3, name: m[1], p: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { k: 4, not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 4 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 3 : 4)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === -1 ? parent.body : parent.k === 3 ? parent.body : parent.els ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 3 ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(S, V, p) {
  let v;
  let found = false;
  for (let i = S.length - 1; i >= 0; i--) {
    if (Object.hasOwn(S[i], p[0])) {
      v = S[i][p[0]];
      found = true;
      break;
    }
  }
  if (!found) {
    if (Object.hasOwn(V, p[0])) v = V[p[0]];
    else return undefined;
  }
  for (let k = 1; k < p.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[k])) return undefined;
    v = v[p[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** The value at `path`, written escaped: lookup, text and escape in one call. */
function valEsc(S, V, p) {
  const v = lookup(S, V, p);
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

/** The value at `path`, written raw: lookup and text in one call. */
function valRaw(S, V, p) {
  const v = lookup(S, V, p);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** An include: the template `name` rendered in the same scope, at most 8 deep. */
function incTpl(name, V, S, D, H, o) {
  if (D >= 8) return;
  const t = H.tpl.get(name);
  if (t !== undefined) t.f(V, S, D + 1, H, o, t.P);
}

/**
 * A template compiled to a render function (V, S, D, H, o, P): it appends
 * its output to `o`. Text runs become single pushes, loops and ifs become
 * native control flow, and one scope object is reused across a loop's
 * iterations (nothing can observe one iteration's values after it ends).
 * Every path the template reads is collected once, in P, so no lookup
 * allocates an array.
 */
function compileTpl(name, src) {
  const nodes = parseTpl(name, src);
  let uid = 0;
  const paths = [];
  const pIdx = new Map();
  const pi = (p) => {
    const key = JSON.stringify(p);
    let idx = pIdx.get(key);
    if (idx === undefined) {
      idx = paths.length;
      paths.push(p);
      pIdx.set(key, idx);
    }
    return idx;
  };
  const gen = (list) => {
    let s = '';
    for (const nd of list) {
      if (nd.k === 0) s += `o.push(${JSON.stringify(nd.t)});`;
      else if (nd.k === 1) s += `o.push(H.ev(S,V,P[${pi(nd.p)}]));`;
      else if (nd.k === 2) s += `o.push(H.rv(S,V,P[${pi(nd.p)}]));`;
      else if (nd.k === 3) {
        const u = ++uid;
        const nm = JSON.stringify(nd.name);
        const p = `P[${pi(nd.p)}]`;
        s += `{const _a${u}=H.lk(S,V,${p});if(Array.isArray(_a${u})){const _s${u}={};const _l${u}={index:0,first:false,last:false,length:_a${u}.length};_s${u}[${nm}]=null;_s${u}.loop=_l${u};S.push(_s${u});for(let _k${u}=0;_k${u}<_a${u}.length;_k${u}++){_s${u}[${nm}]=_a${u}[_k${u}];_s${u}.loop=_l${u};_l${u}.index=_k${u}+1;_l${u}.first=_k${u}===0;_l${u}.last=_k${u}===_a${u}.length-1;${gen(nd.body)}}S.pop();}}`;
      } else if (nd.k === 4) {
        s += `if(H.tr(H.lk(S,V,P[${pi(nd.p)}]))!==${nd.not}){${gen(nd.then)}}`;
        if (nd.els !== null) s += `else{${gen(nd.els)}}`;
      } else if (nd.k === 5) {
        s += `H.inc(${JSON.stringify(nd.name)},V,S,D,H,o);`;
      }
    }
    return s;
  };
  return { f: new Function('V', 'S', 'D', 'H', 'o', 'P', gen(nodes)), P: paths };
}

// ---------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One source's link resolver: a link's href, reporting the broken ones. */
function makeLink(dir, bySource, staticPaths, base, broken, srcPath) {
  return (target) => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
    if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
    broken.add(`broken-link ${srcPath} -> ${target}`);
    return target;
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const dateCache = new Map();
  const longOf = (d) => {
    let s = dateCache.get(d);
    if (s === undefined) {
      s = longDate(d);
      dateCache.set(d, s);
    }
    return s;
  };

  // Templates, parsed and compiled in code-unit order of name. One that
  // does not parse is reported and left out, as if it were not there.
  const tpl = new Map();
  const report = [];
  const H = { ev: valEsc, rv: valRaw, tr: truthy, lk: lookup, inc: incTpl, tpl };
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      tpl.set(name, compileTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push(f);
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!tpl.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugCached(slugCache, s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved, its reading time counted once.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const link = makeLink(dirOf(s.path), bySource, staticPaths, base, broken, s.path);
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readMin = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // Collections: the posts, newest first and then by slug; newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of (p.data.tags ?? [])) {
      const slug = slugCached(slugCache, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of (s.data.tags ?? [])) {
      const slug = slugCached(slugCache, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longOf(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readMin,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));
  const output = {};
  // One root-vars object, one scope array and one output array per case,
  // reused across renders: a render sets its own vars (the rest undefined,
  // which reads exactly as absent) and clears the arrays afterwards.
  const V = { site: siteCtx, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const S = [];
  const o = [];
  const render = (name, vars) => {
    const t = tpl.get(name);
    if (t === undefined) return null;
    V.page = vars.page;
    V.posts = vars.posts;
    V.pager = vars.pager;
    V.tag = vars.tag;
    o.length = 0;
    t.f(V, S, 0, H, o, t.P);
    S.length = 0;
    return o.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  let pagesN = 0;
  for (const s of kept) if (!s.post) pagesN++;
  lines.push(`built ${pagesN} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
