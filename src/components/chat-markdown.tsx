"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-ink [&_a]:underline [&_a]:underline-offset-2 [&_a]:text-state-working [&_blockquote]:border-l-[3px] [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-ink-soft [&_h1]:mb-1.5 [&_h1]:mt-3 [&_h1]:font-sans [&_h1]:text-lg [&_h1]:font-extrabold [&_h1]:tracking-tight [&_h1]:text-ink [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:font-sans [&_h2]:text-base [&_h2]:font-extrabold [&_h2]:tracking-tight [&_h2]:text-ink [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-sans [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-ink [&_hr]:my-3 [&_hr]:border-line [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-panel-hi [&_th]:px-2 [&_th]:py-1 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md border border-line bg-deck p-3 font-mono text-xs leading-relaxed text-ink-soft">
              {children}
            </pre>
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? "");
            return (
              <code
                {...rest}
                className={
                  isBlock
                    ? "font-mono text-xs text-ink-soft"
                    : "rounded border border-line bg-panel-hi px-1 py-0.5 font-mono text-[12px] text-ink"
                }
              >
                {children}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
