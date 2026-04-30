import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
}

/**
 * Only allow http(s) and mailto for rendered links. Without this,
 * `[click me](javascript:alert(token))` or `data:` / `file:` URIs
 * embedded in Claude's output (or in stored conversation text the
 * model surfaces back) execute in the user's browser context.
 */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  // Reject anything that looks like javascript:, data:, file:, vbscript:, etc.
  // Allowlist-only on the protocol prefix.
  if (/^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div
      className="text-sm text-slate-800 dark:text-white/90 leading-relaxed max-w-none"
      style={{ fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 300 }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-slate-900 dark:text-white">{children}</strong>,
          em: ({ children }) => <em className="text-slate-700 dark:text-white/80">{children}</em>,
          ul: ({ children }) => <ul className="my-2 ml-4 list-disc">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 ml-4 list-decimal">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          a: ({ href, children }) => {
            const safe = safeHref(href);
            if (!safe) {
              // Render as plain text — never let unsafe URIs become clickable.
              return <span className="text-slate-700 dark:text-white/80">{children}</span>;
            }
            return (
              <a
                href={safe}
                className="text-cyan-600 dark:text-cyan-400 hover:underline"
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {children}
              </a>
            );
          },
          h1: ({ children }) => <h1 className="text-lg font-semibold text-slate-900 dark:text-white mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold text-slate-900 dark:text-white mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold text-slate-900 dark:text-white mt-2 mb-1">{children}</h3>,
          code: ({ children }) => (
            <code className="bg-slate-200 dark:bg-white/10 px-1.5 py-0.5 rounded text-cyan-700 dark:text-cyan-300 text-xs font-mono">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="bg-slate-200 dark:bg-black/30 border border-slate-300 dark:border-white/10 p-3 rounded my-2 overflow-x-auto">{children}</pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
