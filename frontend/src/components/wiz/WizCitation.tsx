import { createContext, useContext } from 'react';
import type { DataMessagePartProps } from '@assistant-ui/react';
import type { CitationPart } from '../../api/messageParts';

const SeekContext = createContext<(seconds: number) => void>(() => undefined);
export const WizSeekProvider = SeekContext.Provider;

function formatCitationTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const remainder = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export default function WizCitation({ data }: DataMessagePartProps<CitationPart>) {
  const seek = useContext(SeekContext);
  const label = formatCitationTime(data.start_seconds);
  return <button
    type="button"
    aria-label={`Seek video to ${label}`}
    onClick={() => seek(data.start_seconds)}
    className="inline-flex items-center px-1.5 mx-0.5 my-1 rounded-md bg-violet-500/10 wiz-accent-text hover:bg-violet-500/20 text-xs font-mono border border-violet-500/20 cursor-pointer focus-visible:outline-2 focus-visible:outline-violet-500"
  >{label}</button>;
}
