import { createContext, useContext } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import remarkTimestampCitations from './remarkTimestampCitations';

const SeekContext = createContext<(seconds: number) => void>(() => undefined);
export const WizSeekProvider = SeekContext.Provider;

export default function WizMarkdown() {
  const seek = useContext(SeekContext);
  return <MarkdownTextPrimitive
    smooth={false}
    skipHtml
    remarkPlugins={[remarkGfm, remarkTimestampCitations]}
    className="wiz-markdown text-sm leading-7 break-words"
    components={{
      button: ({ children, value }) => <button
        type="button"
        aria-label={`Seek video to ${String(children)}`}
        onClick={() => seek(Number(value))}
        className="inline-flex items-center align-baseline px-1.5 mx-0.5 rounded-md bg-violet-500/10 wiz-accent-text hover:bg-violet-500/20 text-xs font-mono border border-violet-500/20 cursor-pointer focus-visible:outline-2 focus-visible:outline-violet-500"
      >{children}</button>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="wiz-accent-text underline underline-offset-2">{children}</a>,
    }}
  />;
}
