import { useState } from "react";
import Sheet from "../Sheet.tsx";
import { serif, typewriter } from "../style/theme.ts";
import { useFeatures, type Features } from "../features";

export default function LegalPapers({ signup = false, standalone = false, mockFeatures }: { signup?: boolean; standalone?: boolean; mockFeatures?: Features }) {
  const features = useFeatures(mockFeatures);
  const [paper, setPaper] = useState<"Privacy" | "Terms" | null>(() => {
    if (!standalone) return null;
    return window.location.pathname === '/terms' || new URLSearchParams(window.location.search).get('legal') === 'terms' ? 'Terms' : 'Privacy';
  });
  const link = "inline-flex min-h-11 min-w-11 items-center justify-center underline underline-offset-4 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4";
  return <>
    {!standalone && <p className="mt-3 text-sm">
      {signup ? features.termsAcceptance ? "Read the " : "By signing up you agree to the " : "Papers at the ticket counter: "}
      <button type="button" className={link} onClick={() => setPaper("Terms")}>Terms</button>
      {signup ? " and " : " · "}
      <button type="button" className={link} onClick={() => setPaper("Privacy")}>Privacy</button>.
    </p>}
    <Sheet sheet={paper ? { id: `legal-${paper}`, title: paper, body: (
      <article className="space-y-3 text-[15px] leading-relaxed text-[#2a1d14]" style={typewriter}>
        <h2 className="text-3xl" style={serif}>{paper}</h2>
        {!features.legalContactEmail && <p className="text-sm font-bold">DRAFT · For the site owner to review</p>}
        <p className="text-sm">Last updated October 9, 2026</p>
        {features.legalOwnerName && <p>Owner: {features.legalOwnerName}</p>}
        {paper === "Privacy" ? <>
          <p>Wayside Station stores your email and username to run your account, and your avatar and items, scores, coins and transactions, watched films, posts, photos, inbox mail, and chat to make the station work. Some live chat stays only in memory.{features.reports && " Reported chat may be retained for review, together with reports and block preferences."}</p>
          <p>Your email and private inbox are private. Your username, avatar, scores, standings, posts, shared photos, and lounge chat can be seen by other riders.</p>
          <p>We do not sell your data or run ads. We use account and session information to keep you signed in and protect the station.</p>
          <p>In Settings, choose “Download my data” for a JSON copy, or “Close your account” when available to erase private data and free your email. Public scores, standings and past match results remain under “Deleted rider,” with no avatar. Copies other people downloaded cannot be recalled.</p>
        </> : <>
          <p>The station is a place to play games, share posts and photos, and join the Scareathon. Keep your password and agent keys safe. Only upload content you have permission to share.</p>
          {features.ageGate && <p>You must be {features.ageGateMinAge} or older to use Wayside Station. Children under {features.ageGateMinAge} may not create an account or share content.</p>}
          <p>Be kind to other riders. Do not harass people, post illegal material, cheat, or disrupt the service. The owner may remove harmful content or suspend abusive accounts.</p>
          <p>Coins have no real-money value and can&apos;t be bought or cashed out. Items are for use in the station. Features, games and rewards may change, and the service may sometimes be unavailable.</p>
          <p>You can download your data or close your account when available in Settings. Private data is erased; public scores and results remain anonymously as “Deleted rider.” Read the Privacy paper for what we store and why.</p>
        </>}
        {features.geoAllowedCountries.length > 0 && <p>Regions: Wayside Station is available in {features.geoAllowedCountries.join(', ')} when the regional allowlist is active. Unknown locations are allowed.</p>}
        <p>Processors: Supabase (authentication and storage), Railway (API), Vercel (hosting).</p>
        {features.legalContactEmail && <>
          <p>Questions, help or privacy requests: <a className={link} href={`mailto:${features.legalContactEmail}`}>{features.legalContactEmail}</a>.</p>
          <h3 className="text-xl" style={serif}>DMCA / takedown requests</h3>
          <p>Send a copyright or takedown request to <a className={link} href={`mailto:${features.legalContactEmail}`}>{features.legalContactEmail}</a>. Identify the work and the content or URL to remove, include your contact details and signature, and state your good-faith belief that the use is unauthorized and that the notice is accurate and you are authorized to act. The owner will review requests and may remove the content or contact you for more information.</p>
        </>}
      </article>
    ) } : null} onClose={() => setPaper(null)} above />
  </>;
}
