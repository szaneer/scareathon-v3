import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '../../fetchWithAuth';
import Sheet from '../Sheet';
import { useFeatures } from '../features';
import { serif, stubButton } from '../style/theme';
import { acceptTerms, termsStatus } from '../terms';
import type { GoTo } from '../stops';
import LegalPapers from './LegalPapers';
import TermsNotice from './TermsNotice';

const dismissedInSession = (key: string) => {
  try { return sessionStorage.getItem(key) === 'later'; } catch { return false; }
};

export default function ComplianceNotices({ userId, goTo }: { userId?: string; goTo: GoTo }) {
  const features = useFeatures();
  const client = useQueryClient();
  const [region, setRegion] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState('');
  const legal = typeof window !== 'undefined' && (['/privacy', '/terms'].includes(window.location.pathname) || new URLSearchParams(window.location.search).has('legal'));
  const terms = useQuery({
    queryKey: ['terms-acceptance', userId, features.termsVersion],
    enabled: features.termsAcceptance && Boolean(userId), queryFn: termsStatus,
    staleTime: 60_000, refetchInterval: 60_000,
  });
  const age = useQuery({
    queryKey: ['age-confirmation', userId], enabled: features.ageGate && !features.termsAcceptance && Boolean(userId),
    queryFn: async () => {
      const response = await fetchWithAuth('/user/age-confirmation');
      if (!response.ok) throw new Error('Could not check your ticket. Please try again.');
      return response.json() as Promise<{ required: boolean }>;
    }, staleTime: 60_000, refetchInterval: 60_000,
  });
  const version = terms.data?.currentVersion ?? features.termsVersion;
  const dismissalKey = `ws-house-rules:${userId}:${features.termsAcceptance ? version : 'age'}`;
  useEffect(() => { setDismissed(''); setChecked(false); setError(''); }, [userId, version]);
  useEffect(() => {
    const blocked = () => setRegion(true);
    const sharingRequired = () => {
      try { sessionStorage.removeItem(dismissalKey); } catch { /* memory fallback */ }
      setDismissed('');
      void client.invalidateQueries({ queryKey: ['station-features'] });
      void client.invalidateQueries({ queryKey: ['terms-acceptance'] });
      void client.invalidateQueries({ queryKey: ['age-confirmation'] });
    };
    window.addEventListener('ws-region-unavailable', blocked);
    window.addEventListener('ws-age-required', sharingRequired);
    window.addEventListener('ws-terms-required', sharingRequired);
    return () => {
      window.removeEventListener('ws-region-unavailable', blocked);
      window.removeEventListener('ws-age-required', sharingRequired);
      window.removeEventListener('ws-terms-required', sharingRequired);
    };
  }, [client, dismissalKey]);
  const readLater = () => {
    setRegion(false); setDismissed(dismissalKey);
    try { sessionStorage.setItem(dismissalKey, 'later'); } catch { /* memory fallback */ }
  };
  const needsTerms = features.termsAcceptance && terms.data?.required === true;
  const needsAge = features.ageGate && (features.termsAcceptance ? terms.data?.ageRequired : age.data?.required) === true;
  const visible = !legal && dismissed !== dismissalKey && !dismissedInSession(dismissalKey);
  const confirm = async () => {
    setBusy(true); setError('');
    try {
      if (needsTerms && version) {
        const status = await acceptTerms(version, checked);
        client.setQueryData(['terms-acceptance', userId, features.termsVersion], status);
      } else {
        const response = await fetchWithAuth('/user/age-confirmation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
        if (!response.ok) throw new Error((await response.json()).error || 'Please try again.');
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ['terms-acceptance'] }),
        client.invalidateQueries({ queryKey: ['age-confirmation'] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Please try again.');
      void client.invalidateQueries({ queryKey: ['station-features'] });
      void client.invalidateQueries({ queryKey: ['terms-acceptance'] });
    } finally { setBusy(false); }
  };
  return <>
    {legal && <LegalPapers standalone />}
    <Sheet above sheet={region ? { id: 'region-notice', title: 'Station notice', body: <div className="space-y-3 text-[#2a1d14]"><p>Wayside Station isn&apos;t available in your region yet.</p><p>You can still download your data or close your account in Settings.</p><button className={stubButton} onClick={() => { setRegion(false); goTo('mail', 'register'); }}>Open Settings</button></div> } : !needsTerms && needsAge && visible ? {
      id: 'age-confirmation', title: 'Your ticket · age confirmation', body: <div className="space-y-3 text-[#2a1d14]">
        <h2 className="text-2xl" style={serif}>Your ticket · age confirmation</h2>
        <p>Please confirm your age once before posting, chatting, sharing photos or listing items.</p>
        <label className="flex min-h-11 items-center gap-3"><input className="h-5 w-5 accent-[#1d2a3a]" type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />I&apos;m {features.ageGateMinAge} or older</label>
        <button type="button" className={`${stubButton} min-h-11`} disabled={!checked || busy} onClick={() => void confirm()}>Confirm</button>
        {error && <p role="alert">{error}</p>}
      </div>,
    } : null} onClose={readLater} />
    <TermsNotice open={!region && needsTerms && visible} ageRequired={needsAge} features={{ ...features, termsVersion: version }} checked={checked} onChecked={setChecked} busy={busy} error={error} onAgree={() => void confirm()} onLater={readLater} />
  </>;
}
