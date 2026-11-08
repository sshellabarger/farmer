/**
 * A deliberately small Markdown renderer for the rules and the Hold Harmless
 * text (both are market data the admin pastes in). Supported: #, ## and ###
 * headings, "-" or "*" bullets, "1." lists, paragraphs, **bold**,
 * [text](https://...) links (http and https only), "---" rules. There is no raw
 * HTML passthrough: everything comes out as text nodes the React renderer escapes.
 */

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'bold'; text: string }
  | { t: 'link'; text: string; href: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; inline: Inline[] }
  | { t: 'p'; inline: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'hr' };

const INLINE_RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(src)) !== null) {
    if (m.index > last) out.push({ t: 'text', text: src.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ t: 'bold', text: m[1] });
    } else if (/^https?:\/\//i.test(m[3]!)) {
      out.push({ t: 'link', text: m[2]!, href: m[3]! });
    } else {
      // Unsafe or relative target: keep the visible text, drop the link.
      out.push({ t: 'text', text: m[2]! });
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', text: src.slice(last) });
  return out;
}

const BULLET_RE = /^\s{0,3}[-*]\s+(.*)$/;
const ORDERED_RE = /^\s{0,3}\d+[.)]\s+(.*)$/;
const HEADING_RE = /^(#{1,3})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(-{3,}|\*{3,})\s*$/;

export function renderMarkdownLite(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ t: 'p', inline: parseInline(para.join(' ')) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ t: list.kind, items: list.items.map(parseInline) });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    if (HR_RE.test(line)) {
      flushPara();
      flushList();
      blocks.push({ t: 'hr' });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3, inline: parseInline(h[2]!) });
      continue;
    }
    const b = BULLET_RE.exec(line);
    const o = b ? null : ORDERED_RE.exec(line);
    if (b || o) {
      flushPara();
      const kind: 'ul' | 'ol' = b ? 'ul' : 'ol';
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      list.items.push((b ?? o)![1]!);
      continue;
    }
    // A plain line directly under a list item continues that item when indented, else starts a paragraph.
    if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}
