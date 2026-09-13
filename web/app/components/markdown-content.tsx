'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown-content.css';

export function MarkdownContent({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children, ...props }) => {
            const external = /^https?:\/\//i.test(href ?? '');
            return (
              <a
                {...props}
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noreferrer noopener' : undefined}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
