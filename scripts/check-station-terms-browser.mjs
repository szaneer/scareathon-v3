import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.TERMS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.TERMS_PLAYWRIGHT_MODULE).href : 'playwright');
const base = process.env.TERMS_BASE_URL || 'http://127.0.0.1:5173';
const shots = process.env.TERMS_SHOTS_DIR || 'work/review-shots';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const heading = "We've added house rules";
try {
  await mkdir(shots, { recursive: true });
  for (const [width, height] of [[390, 844], [1440, 900]]) for (const mode of ['terms', 'terms-age']) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(), errors = [], backend = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('request', request => { if (/supabase|\/config\/features|\/user\//.test(request.url())) backend.push(request.url()); });
    await page.goto(`${base}/station?preview=${mode}`);
    const dialog = page.getByRole('dialog', { name: heading, exact: true });
    await dialog.waitFor();
    assert.equal(await page.getByRole('checkbox').count(), mode === 'terms-age' ? 1 : 0);
    const agree = page.getByRole('button', { name: 'I agree', exact: true });
    if (mode === 'terms-age') assert.equal(await agree.isEnabled(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for (const button of await dialog.getByRole('button').all()) {
      const box = await button.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44, '44px button target');
    }
    await page.screenshot({ path: `${shots}/${mode}-${width}x${height}.png` });
    await page.getByRole('button', { name: 'Read later', exact: true }).last().focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, 'focus stays in notice');
    await page.getByRole('button', { name: 'Terms', exact: true }).click();
    await page.getByRole('dialog', { name: 'Terms', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Read the notice', exact: true }).click();
    if (mode === 'terms-age') await page.getByRole('checkbox').check();
    await agree.click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(backend, [], 'preview makes no backend requests'); assert.deepEqual(errors, []);
    await context.close();
    console.log(`Preview passed: ${mode} ${width}x${height}`);
  }
  async function fixture({ active = true, age = false, kiosk = false, emailConfirmation = false, metadata = {} } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(), errors = [], calls = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    console.log('Fixture:', { active, age, kiosk, emailConfirmation });
    const state = { active, age, version: '2026-10-01', saved: null, ageConfirmed: false };
    await page.addInitScript(({ kiosk, emailConfirmation, metadata }) => {
      window.__termsTest = { kiosk, emailConfirmation, session: kiosk ? null : { user: { id: 'existing-rider', user_metadata: metadata }, access_token: 'mock' } };
    }, { kiosk, emailConfirmation, metadata });
    await page.route('**/src/main.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: "import '/scripts/terms-browser-fixture.jsx';" }));
    await page.route('**/config/features', route => route.fulfill({ json: { geoBlock: false, geoAllowedCountries: [], ageGate: state.age, ageGateMinAge: state.age ? 13 : null, termsAcceptance: state.active, termsVersion: state.active ? state.version : null, reports: false, legalContactEmail: 'legal@example.com', legalOwnerName: null, accountDeletion: false, emailChange: true } }));
    await page.route('**/user/terms-acceptance', async route => {
      const request = route.request(); calls.push(request.method());
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        assert.equal(body.accepted, true); assert.equal(body.version, state.version);
        if (state.age && !state.ageConfirmed) assert.equal(body.ageConfirmed, true);
        state.saved = state.version; if (body.ageConfirmed) state.ageConfirmed = true;
      }
      await route.fulfill({ json: { required: state.saved !== state.version, currentVersion: state.version, acceptedAt: state.saved ? '2026-10-09T00:00:00Z' : null, versionAccepted: state.saved, ageRequired: state.age && !state.ageConfirmed } });
    });
    await page.route('**/user/age-confirmation', route => route.fulfill({ json: { required: false } }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.__termsTest.refresh), null, { timeout: 10000 });
    return { context, page, state, calls, errors };
  }
  {
    const { context, page, calls } = await fixture({ active: false });
    await page.evaluate(() => window.__termsTest.refresh());
    assert.equal(await page.getByRole('dialog', { name: heading }).count(), 0); assert.deepEqual(calls, []);
    await context.close();
  }
  {
    const { context, page, state, errors } = await fixture({ age: true });
    const dialog = page.getByRole('dialog', { name: heading, exact: true }); await dialog.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'one combined prompt');
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'I agree', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    state.version = '2026-11-01'; await page.evaluate(() => window.__termsTest.refresh()); await dialog.waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 0, 'confirmed age is not asked again');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.reload(); await page.waitForFunction(() => Boolean(window.__termsTest.refresh));
    assert.equal(await dialog.count(), 0, 'Read later survives reload in this session');
    state.version = '2026-12-01'; await page.evaluate(() => window.__termsTest.refresh()); await dialog.waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Try sharing' }).click(); await dialog.waitFor();
    await page.getByRole('button', { name: 'I agree', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []); await context.close();
  }
  for (const emailConfirmation of [false, true]) {
    const { context, page, calls, errors } = await fixture({ age: true, kiosk: true, emailConfirmation });
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const agreed = page.getByRole('checkbox', { name: 'I agree to the Terms and Privacy paper.' });
    await agreed.waitFor();
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('rider@example.com');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
    assert.equal(await page.evaluate(() => Boolean(window.__termsTest.signup)), false, 'signup requires explicit agreement');
    await agreed.check(); await page.getByRole('checkbox', { name: "I'm 13 or older" }).check();
    const saved = page.waitForResponse(response => response.url().endsWith('/user/terms-acceptance') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
    if (emailConfirmation) {
      await page.getByText('Check your inbox', { exact: true }).waitFor();
      await page.evaluate(() => window.__termsTest.confirmEmail());
    }
    await page.waitForFunction(() => window.__termsTest.signup?.options.data.station_terms_signup_agreed === true);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await saved;
    assert.equal(calls.includes('POST'), true, 'signup agreement saved');
    assert.equal(await page.getByRole('dialog', { name: heading }).count(), 0, 'signup does not re-prompt');
    assert.equal(await page.evaluate(() => window.__termsTest.noticeSeen), false, 'signup never flashes the notice');
    assert.deepEqual(errors, []); await context.close();
  }
  console.log('Terms browser checks passed: four layouts, focus/Escape, links, no-backend previews, switch off, combined acceptance, version bump, session dismissal, reopening, immediate and email-confirmed signup.');
} finally { await browser.close(); }
