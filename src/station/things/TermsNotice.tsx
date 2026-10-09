import Sheet from '../Sheet';
import type { Features } from '../features';
import { serif, stubButton } from '../style/theme';
import LegalPapers from './LegalPapers';

// A paper from the ticket counter; the live flow and staging previews share it.
export default function TermsNotice({ open, ageRequired, features, checked, onChecked, busy, error, onAgree, onLater }: {
  open: boolean; ageRequired: boolean; features: Features; checked: boolean;
  onChecked: (checked: boolean) => void; busy: boolean; error: string;
  onAgree: () => void; onLater: () => void;
}) {
  return <Sheet above closeLabel="Read later" onClose={onLater} sheet={open ? {
    id: 'terms-notice', title: "We've added house rules", body: <article className="space-y-4 text-[15px] leading-relaxed text-[#2a1d14]">
      <p className="border-b border-dotted border-[#2a1d14]/40 pb-3 text-[11px] uppercase tracking-[0.2em]">Wayside Station · Ticket counter</p>
      <h2 className="text-[32px] leading-tight" style={serif}>We&apos;ve added house rules</h2>
      <p>Wayside Station now has Terms and a Privacy paper. They explain the house rules and how we look after your information.</p>
      <LegalPapers mockFeatures={features} />
      {ageRequired && <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-4">
        <input className="h-5 w-5 shrink-0 accent-[#1d2a3a]" type="checkbox" checked={checked} disabled={busy} onChange={event => onChecked(event.target.checked)} />
        I&apos;m {features.ageGateMinAge} or older
      </label>}
      <p className="text-sm">You can keep reading and playing. Please agree before posting, chatting, sharing photos or listing items.</p>
      {error && <p role="alert" className="font-semibold text-red-900">{error}</p>}
      <div className="flex flex-wrap items-center gap-3 border-t border-dotted border-[#2a1d14]/40 pt-4">
        <button type="button" className={`${stubButton} min-h-11`} disabled={busy || (ageRequired && !checked)} onClick={onAgree}>{busy ? 'One moment…' : 'I agree'}</button>
        <button type="button" className="min-h-11 rounded-sm px-3 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" onClick={onLater}>Read later</button>
      </div>
      <p className="text-xs">House rules · {features.termsVersion}</p>
    </article>,
  } : null} />;
}
