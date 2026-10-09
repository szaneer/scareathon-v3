// Used only by check-station-terms-browser.mjs through a Playwright entry override.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NavigatorProvider } from '../src/components/navigator/context';
import ComplianceNotices from '../src/station/things/ComplianceNotices';
import { KioskWindow } from '../src/station/things/Kiosk';
import { supabase } from '../src/supabaseClient';
import '../src/index.css';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const test = window.__termsTest;
test.noticeSeen = false;
new MutationObserver(() => {
  if (document.querySelector('[role="dialog"][aria-label="We\'ve added house rules"]')) test.noticeSeen = true;
}).observe(document.body, { childList: true, subtree: true });
supabase.auth.getSession = async () => ({ data: { session: test.session }, error: null });
supabase.auth.signUp = async credentials => {
  test.signup = credentials;
  const user = { id: 'new-rider', user_metadata: credentials.options.data || {} };
  test.pendingUser = user;
  if (!test.emailConfirmation) { test.session = { user, access_token: 'mock' }; render(); }
  return { data: { user, session: test.session }, error: null };
};
function render() {
  root.render(<QueryClientProvider client={client}><NavigatorProvider><MemoryRouter>
    <main className="min-h-screen bg-[#111820] p-6">
      <button onClick={() => window.dispatchEvent(new Event('ws-terms-required'))}>Try sharing</button>
      {test.kiosk && !test.session ? <div className="mx-auto max-w-sm bg-[#f2ead2] p-5"><KioskWindow signedIn={false} onShop={() => {}} goTo={() => {}} glass={false} /></div> : null}
      <ComplianceNotices userId={test.session?.user.id} goTo={() => {}} />
    </main>
  </MemoryRouter></NavigatorProvider></QueryClientProvider>);
}
const root = createRoot(document.getElementById('root'));
test.refresh = () => client.invalidateQueries();
test.confirmEmail = () => { test.session = { user: test.pendingUser, access_token: 'mock' }; render(); };
render();
