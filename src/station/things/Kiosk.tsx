import { fetchWithAuth } from "../../fetchWithAuth";
import { useFeatures } from "../features";
import LegalPapers from "./LegalPapers.tsx";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../../supabaseClient";
import { isRetryableAuthError } from "../../authErrors";
import PasswordResetPopup from "../../components/PasswordResetPopup";
import { AvatarView } from "../../components/avatar/AvatarView";
import { useInboxUnreadCount } from "../../pages/Inbox/useInboxUnreadCount";
import NewsDot from "../../components/NewsDot";
import { useSummary } from "../data.ts";
import type { GoTo } from "../stops.ts";
import { useAvatarLook } from "./Belongings.tsx";
import { useBackdrop } from "./Banners.tsx";
import { serif, stubButton, typewriter } from "../style/theme.ts";

// The ticket counter. Its window is where you sign in (or buy a ticket, i.e. sign up), and
// once you have a ticket it shows yours, with the way to the item shop.

const field =
  "w-full rounded-[2px] border border-[#2a1d14]/30 bg-[#fffaf0]/90 px-2.5 py-1.5 text-[15px] text-[#2a1d14] placeholder:text-[#2a1d14]/85 focus:border-[#2a1d14]/70 focus:outline-none";

function authErrorMessage(error: unknown) {
  if (isRetryableAuthError(error) || error instanceof TypeError) return "The line to headquarters is down. Try again in a moment.";
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "invalid_credentials") return "That email and password don't match.";
  if (code === "email_not_confirmed") return "Confirm your email first; the link's in your inbox.";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "Too many tries. Give it a minute.";
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

// Where the confirmation link brings you back to: this window, held up
const confirmRedirect = () => new URL("/station?at=tickets&open=window", window.location.origin).toString();

// A confirmation link that didn't work (expired, already used, or used up by a mail
// scanner clicking it first) comes back with the error in the URL's hash. Read once, as
// the page loads, then cleared so a reload doesn't show it again.
// (exported: the station holds the window up for you when you arrive like that)
// eslint-disable-next-line react-refresh/only-export-components
export const linkFailed = (() => {
  if (typeof window === "undefined") return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (!hash.get("error_code") && !hash.get("error")) return false;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  return true;
})();

// A card held up behind the glass: the sign-in form
function SignInCard() {
  const features = useFeatures();
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);
  useEffect(() => { setTermsAgreed(false); }, [features.termsVersion]);
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(linkFailed ? "That confirmation link has expired or was already used. Put your email in and we'll send a fresh one." : null);
  const [busy, setBusy] = useState(false);
  const [sentConfirmation, setSentConfirmation] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Offer to send the confirmation link again (after a dud link, or signing in unconfirmed)
  const [canResend, setCanResend] = useState(linkFailed);
  const [resent, setResent] = useState(false);

  const resend = async () => {
    if (busy) return;
    if (!email.trim()) {
      setError("Put your email in first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: resendError } = await supabase.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: confirmRedirect() } });
      if (resendError) throw resendError;
      setResent(true);
      setCanResend(false);
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!isLogin && features.ageGate && !ageConfirmed) throw new Error(`Confirm that you are ${features.ageGateMinAge} or older.`);
      if (!isLogin && features.termsAcceptance && !termsAgreed) throw new Error('Please agree to the Terms and Privacy paper.');
      const credentials = { email: email.trim(), password };
      if (isLogin) {
        const { error: signInError } = await supabase.auth.signInWithPassword(credentials);
        if (signInError) {
          if (signInError.code === "email_not_confirmed") setCanResend(true);
          throw signInError;
        }
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          ...credentials,
          options: { emailRedirectTo: confirmRedirect(), ...(features.termsAcceptance ? { data: { station_terms_signup_agreed: termsAgreed, station_terms_signup_version: features.termsVersion, station_signup_age_confirmed: ageConfirmed } } : {}) },
        });
        if (signUpError) throw signUpError;
        if (data.session && features.ageGate && ageConfirmed) {
          const response = await fetchWithAuth('/user/age-confirmation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
          if (!response.ok) throw new Error('Your account was created. Confirm your age at the ticket counter before sharing content.');
        }
        if (!data.session && data.user) {
          setSentConfirmation(true);
          setPassword("");
        } else if (!data.user) {
          throw new Error("We couldn't issue your ticket. Please try again.");
        }
      }
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (sentConfirmation) {
    return (
      <div className="text-[#2a1d14]">
        <p className="text-[22px]" style={serif}>
          Check your inbox
        </p>
        <p className="mt-2 text-[15px] leading-snug">
          A confirmation link is on its way to <strong>{email.trim()}</strong>. Follow it, then come back and show your ticket.
        </p>
        <p className="mt-1 text-[13px] opacity-75">Nothing after a few minutes? Look in spam, or send it again.</p>
        {resent && <p className="mt-1 text-[13px] font-semibold">Sent again.</p>}
        {error && <p role="alert" className="mt-1 text-[13px] font-semibold text-red-800">{error}</p>}
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className={stubButton} onClick={() => { setSentConfirmation(false); setIsLogin(true); setResent(false); }}>
            Back
          </button>
          <button type="button" className="text-[13px] underline underline-offset-4 opacity-75 hover:opacity-100" disabled={busy} onClick={() => { setResent(false); void resend(); }}>
            {busy ? "Sending…" : "Send it again"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="text-[#2a1d14]">
      <p className="text-[22px] leading-tight" style={serif}>
        {isLogin ? "Show your ticket" : "Create an account (it's free)"}
      </p>
      <p className="text-[13px] opacity-85">Save scores, earn tickets, dress your avatar.</p>
      <form onSubmit={submit} className="mt-2 space-y-1.5" aria-busy={busy}>
        <input className={field} type="email" autoComplete="email" placeholder="Email" aria-label="Email" required value={email} disabled={busy} onChange={(e) => { setEmail(e.target.value); setError(null); }} />
        <input
          className={field}
          type="password"
          placeholder={isLogin ? "Password" : "Password (8 or more characters)"}
          aria-label="Password"
          autoComplete={isLogin ? "current-password" : "new-password"}
          minLength={isLogin ? undefined : 8}
          required
          value={password}
          disabled={busy}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
        />
        {!isLogin && features.termsAcceptance && <label className="flex min-h-11 items-center gap-3 text-sm py-2"><input className="h-5 w-5 accent-[#1d2a3a]" type="checkbox" required checked={termsAgreed} disabled={busy} onChange={event => setTermsAgreed(event.target.checked)} />I agree to the Terms and Privacy paper.</label>}
        {!isLogin && features.ageGate && <label className="flex min-h-11 items-center gap-3 text-sm py-2"><input type="checkbox" required checked={ageConfirmed} disabled={busy} onChange={event => setAgeConfirmed(event.target.checked)} />I&apos;m {features.ageGateMinAge} or older</label>}
        {error && <p role="alert" className="text-[13px] font-semibold text-red-800">{error}</p>}
        {resent && <p className="text-[13px] font-semibold">A fresh confirmation link is on its way to {email.trim()}.</p>}
        {canResend && (
          <button type="button" className="text-[13px] font-semibold underline underline-offset-4" disabled={busy} onClick={() => void resend()}>
            Send the confirmation link again
          </button>
        )}
        <div className="flex items-center gap-3 pt-0.5">
          <button type="submit" className={stubButton} disabled={busy}>
            {busy ? "One moment…" : isLogin ? "Sign in" : "Create account"}
          </button>
          {isLogin && (
            <button type="button" className="text-[13px] underline underline-offset-4 opacity-75 hover:opacity-100" onClick={() => setResetting(true)}>
              Forgot password?
            </button>
          )}
        </div>
      </form>
      {!isLogin && <LegalPapers signup />}
      <p className="mt-2 text-[13px]">
        {isLogin ? "New here? " : "Have a ticket? "}
        <button type="button" className="font-semibold underline underline-offset-4" onClick={() => { setIsLogin(!isLogin); setError(null); }}>
          {isLogin ? "Create account" : "Sign in"}
        </button>
      </p>
      {resetting && <PasswordResetPopup onClose={() => setResetting(false)} initialEmail={email} />}
    </div>
  );
}


// Your ticket, shown in the window once you've signed in: who you are, your coins, the
// shop, and where the rest of your things are kept
function TicketCard({ onShop, goTo }: { onShop: () => void; goTo: GoTo }) {
  const { data: summary } = useSummary();
  const unread = useInboxUnreadCount();
  const look = useAvatarLook();
  const backdrop = useBackdrop();
  return (
    <div className="flex h-full gap-4 text-[#2a1d14]">
      <div className="flex w-28 shrink-0 items-end justify-center overflow-hidden rounded-[2px] bg-gradient-to-b from-[#2a2238] to-[#120d08]" style={backdrop}>
        <AvatarView look={look} height={144} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-[11px] uppercase tracking-[0.25em] opacity-85">Passenger</p>
        <p className="truncate text-[26px] leading-tight" style={serif}>
          {summary?.username ?? "…"}
        </p>
        <p className="text-[16px] font-semibold">{summary?.coinBalance != null ? `${summary.coinBalance.toLocaleString()} tickets` : "…"}</p>
        <div className="mt-auto space-y-1.5">
          <button type="button" className={`${stubButton} w-full justify-center`} onClick={onShop}>
            Item shop
          </button>
          <div className="flex gap-3 text-[13px]">
            <button type="button" className="underline decoration-[#2a1d14]/40 underline-offset-4" onClick={() => goTo("lockers")}>
              Your locker
            </button>
            <button type="button" className="underline decoration-[#2a1d14]/40 underline-offset-4" onClick={() => goTo("mail")}>
              {unread ? `Inbox (${unread})` : "Inbox"}
              {unread ? <NewsDot className="ml-1.5 align-middle" label="Unread mail" /> : null}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// What's behind the kiosk's glass. `glass`: drawn as the card behind the glass; off when a
// phone holds it in its own card
export function KioskWindow({ signedIn, onShop, goTo, glass = true }: { signedIn: boolean | undefined; onShop: () => void; goTo: GoTo; glass?: boolean }) {
  return (
    <div className={glass ? "h-full w-full bg-[#efe3c8]/90 p-4 shadow-[inset_0_0_30px_rgba(120,70,20,0.35)]" : "h-full w-full"} style={typewriter}>
      {signedIn === undefined ? <p className="italic opacity-60">…</p> : signedIn ? <TicketCard onShop={onShop} goTo={goTo} /> : <SignInCard />}
    </div>
  );
}
