import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';

export default function WizMarkdown() {
  return <MarkdownTextPrimitive
    smooth={false}
    skipHtml
    remarkPlugins={[remarkGfm]}
    className="wiz-markdown text-sm leading-7 break-words"
    components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="wiz-accent-text underline underline-offset-2">{children}</a>,
    }}
  />;
}
