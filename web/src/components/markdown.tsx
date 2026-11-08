import type { ReactNode } from 'react';
import { renderMarkdownLite, type Block, type Inline } from '@/lib/markdown-lite';

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === 'bold') return <strong key={i}>{n.text}</strong>;
        if (n.t === 'link') {
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-green-700 underline">
              {n.text}
            </a>
          );
        }
        return <span key={i}>{n.text}</span>;
      })}
    </>
  );
}

function BlockNode({ block }: { block: Block }): ReactNode {
  switch (block.t) {
    case 'h': {
      const cls =
        block.level === 1
          ? 'font-display text-[22px] font-semibold text-green-800 mt-8 mb-3'
          : block.level === 2
            ? 'font-display text-[19px] font-semibold text-green-800 mt-7 mb-2'
            : 'text-[15px] font-bold text-earth-800 mt-5 mb-1';
      const Tag = (block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
      return (
        <Tag className={cls}>
          <InlineNodes nodes={block.inline} />
        </Tag>
      );
    }
    case 'p':
      return (
        <p className="text-[15px] leading-relaxed text-text my-3">
          <InlineNodes nodes={block.inline} />
        </p>
      );
    case 'ul':
      return (
        <ul className="list-disc pl-5 my-3 space-y-1.5 text-[15px] leading-relaxed text-text">
          {block.items.map((it, i) => (
            <li key={i}>
              <InlineNodes nodes={it} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="list-decimal pl-5 my-3 space-y-1.5 text-[15px] leading-relaxed text-text">
          {block.items.map((it, i) => (
            <li key={i}>
              <InlineNodes nodes={it} />
            </li>
          ))}
        </ol>
      );
    case 'hr':
      return <hr className="my-6 border-0 border-t border-border" />;
  }
}

/** Renders Markdown-lite text (see lib/markdown-lite.ts) with the site's typography. */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const blocks = renderMarkdownLite(source);
  return (
    <div className={className}>
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} />
      ))}
    </div>
  );
}
