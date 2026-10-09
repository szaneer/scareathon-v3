import { fetchWithAuth } from '../fetchWithAuth';
import { supabase } from '../supabaseClient';

export type TermsStatus = { required: boolean; currentVersion: string | null; acceptedAt: string | null; versionAccepted: string | null; ageRequired: boolean };

export async function acceptTerms(version: string, ageConfirmed: boolean): Promise<TermsStatus> {
  const response = await fetchWithAuth('/user/terms-acceptance', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accepted: true, version, ageConfirmed }),
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Could not save your agreement. Please try again.');
  return response.json() as Promise<TermsStatus>;
}

// Signup intent survives an email-confirmation round trip, including another device.
// It is never a write-gate bypass: only the authenticated POST saves acceptance.
// Never reuse signup intent for a later terms version or an already accepted rider.
export async function termsStatus(): Promise<TermsStatus> {
  const response = await fetchWithAuth('/user/terms-acceptance');
  if (!response.ok) throw new Error('Could not check the house rules. Please try again.');
  const status = await response.json() as TermsStatus;
  if (status.required && !status.acceptedAt && status.currentVersion) {
    const { data: { session } } = await supabase.auth.getSession();
    const metadata = session?.user.user_metadata;
    if (metadata?.station_terms_signup_agreed === true && metadata.station_terms_signup_version === status.currentVersion) {
      return acceptTerms(status.currentVersion, metadata.station_signup_age_confirmed === true);
    }
  }
  return status;
}
