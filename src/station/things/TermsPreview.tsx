import { useState } from 'react';
import { dormant } from '../features';
import { PAPER_GRAIN, plate, serif, stubButton, typewriter } from '../style/theme';
import TermsNotice from './TermsNotice';

// Isolated staging entry: same notice and legal papers, no auth or API modules.
export default function TermsPreview({ combined }: { combined: boolean }) {
  const [open, setOpen] = useState(true);
  const [checked, setChecked] = useState(false);
  const features = { ...dormant, termsAcceptance: true, termsVersion: '2026-10-01', legalContactEmail: 'legal@example.com', ageGate: combined, ageGateMinAge: combined ? 13 : null };
  return <main className="flex min-h-[100dvh] items-center justify-center bg-[#111820] px-6 text-[#f2ead2]" style={typewriter}>
    <div className="text-center">
      <p className={`${plate} px-8 py-4 text-2xl tracking-widest`}>WAYSIDE STATION</p>
      <div className="mx-auto mt-10 w-60 border-8 border-[#3a2b20] bg-[#f2ead2] p-5 text-[#2a1d14] shadow-[6px_10px_0_#05070c]" style={{ backgroundImage: PAPER_GRAIN }}>
        <p className="text-3xl" style={serif}>Ticket counter</p>
        <p className="mt-3 text-sm">House rules</p>
        {!open && <button className={`${stubButton} mt-4 min-h-11`} onClick={() => setOpen(true)}>Read the notice</button>}
      </div>
    </div>
    <TermsNotice open={open} ageRequired={combined} features={features} checked={checked} onChecked={setChecked} busy={false} error="" onAgree={() => setOpen(false)} onLater={() => setOpen(false)} />
  </main>;
}
