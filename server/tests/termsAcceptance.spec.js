import { jest } from '@jest/globals';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const stub = { query: jest.fn() };
jest.unstable_mockModule('../db/mockDB.js', () => ({ default: stub }));
const { default: routes } = await import('../routes/compliance.js');
const { createContentGate, isContentWrite } = await import('../utils/contentSafety.js');
const { registerComplianceRateLimits } = await import('../utils/complianceRateLimits.js');
const { publicFeatures } = await import('../utils/features.js');
const RIDER = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const headers = { authorization: 'test-rider' };
const writes = ['/wayside-online/posts', '/wayside-online/posts/1/reactions', '/wayside-online/lounge/ticket', '/monster-bash/chat', '/picto-box/photos', '/marketplace/listings', '/inbox/conversations', '/inbox/conversations/1/messages'];
let pg, app, query, env;
beforeAll(async () => {
    pg = new PGlite();
    await pg.exec('CREATE TABLE users (id uuid PRIMARY KEY, deleted_at timestamptz); CREATE ROLE authenticated; CREATE ROLE anon;');
    for (const name of ['20261014_compliance.sql', '20261015_terms_acceptance.sql']) {
        const sql = await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
        await pg.exec(sql); await pg.exec(sql);
    }
});
beforeEach(async () => {
    await pg.exec('DELETE FROM users');
    await pg.query('INSERT INTO users(id) VALUES ($1), ($2)', [RIDER, NEW]);
    query = jest.fn((sql, args) => pg.query(sql, args));
    env = { TERMS_VERSION: '2026-10-01', LEGAL_CONTACT_EMAIL: 'legal@example.com' };
    app = Fastify();
    app.decorateRequest('user', null);
    await registerComplianceRateLimits(app);
    app.addHook('preValidation', async (request, reply) => {
        if (request.url === '/config/features') return;
        if (!request.headers.authorization) return reply.code(401).send({ error: 'Sign in' });
        request.user = { sub: request.headers['x-rider'] || RIDER };
    });
    app.addHook('preHandler', createContentGate({ query }, env));
    await app.register(routes, { db: { query }, env });
    for (const url of writes) app.post(url, async () => ({ shared: true }));
    app.get('/wayside-online/threads', async () => ({ reading: true }));
    app.post('/games/submitScore', async () => ({ playing: true }));
    app.get('/user/export', async () => ({ available: true }));
    app.delete('/user/account', async () => ({ available: true }));
});
afterEach(async () => { await app.close(); });
afterAll(async () => { await pg.close(); });
const status = async (rider = RIDER) => (await app.inject({ url: '/user/terms-acceptance', headers: { ...headers, 'x-rider': rider } })).json();
const accept = (payload = {}, rider = RIDER) => app.inject({ method: 'POST', url: '/user/terms-acceptance', headers: { ...headers, 'x-rider': rider }, payload: { accepted: true, version: env.TERMS_VERSION, ...payload } });

test.each([{}, { TERMS_VERSION: 'v1' }, { LEGAL_CONTACT_EMAIL: 'legal@example.com' }, { TERMS_VERSION: ' ', LEGAL_CONTACT_EMAIL: 'legal@example.com' }, { TERMS_VERSION: 'v1', LEGAL_CONTACT_EMAIL: ' ' }])('switch requires both nonempty settings: %j', async settings => {
    Object.keys(env).forEach(key => delete env[key]); Object.assign(env, settings);
    expect(publicFeatures(env)).toMatchObject({ termsAcceptance: false, termsVersion: null });
    expect((await status()).required).toBe(false);
    expect((await accept()).statusCode).toBe(200);
    for (const url of writes) expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(200);
    expect(query).not.toHaveBeenCalled();
});
test('current version is public; account status and acceptance require auth and are uncached', async () => {
    expect((await app.inject('/config/features')).json()).toMatchObject({ termsAcceptance: true, termsVersion: '2026-10-01' });
    expect((await app.inject('/user/terms-acceptance')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/user/terms-acceptance', payload: { accepted: true, version: env.TERMS_VERSION } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/user/terms-acceptance', headers })).headers['cache-control']).toBe('no-store');
    expect((await status()).required).toBe(true);
});
test('all sharing paths are blocked until accepted; reading, gameplay and account access work', async () => {
    for (const url of writes) {
        const response = await app.inject({ method: 'POST', url, headers });
        expect(response.statusCode).toBe(403); expect(response.json().code).toBe('terms_acceptance_required');
    }
    expect((await app.inject({ url: '/wayside-online/threads', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/games/submitScore', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/user/export', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/user/account', headers })).statusCode).toBe(200);
    expect((await accept()).statusCode).toBe(200);
    expect((await status()).required).toBe(false);
    for (const url of writes) expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(200);
    expect(isContentWrite('PUT', '/wayside-online/posts/1')).toBe(true);
    expect(isContentWrite('PATCH', '/wayside-online/posts/1')).toBe(true);
});
test('explicit acceptance, exact current version, server time and repeat idempotence; bump re-prompts', async () => {
    expect((await accept({ accepted: false })).statusCode).toBe(400);
    expect((await accept({ version: 'stale' })).statusCode).toBe(409);
    expect((await status()).acceptedAt).toBeNull();
    expect((await accept({ acceptedAt: 'forged', userId: NEW })).statusCode).toBe(200);
    const first = await status();
    expect(first.acceptedAt).toBeTruthy(); expect(first.versionAccepted).toBe('2026-10-01');
    await accept(); expect((await status()).acceptedAt).toBe(first.acceptedAt);
    expect((await status(NEW)).required).toBe(true);
    env.TERMS_VERSION = '2026-11-01';
    expect((await status()).required).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/monster-bash/chat', headers })).statusCode).toBe(403);
    expect((await accept({ version: '2026-10-01' })).statusCode).toBe(409);
    await accept(); expect(await status()).toMatchObject({ required: false, versionAccepted: '2026-11-01' });
});
test('combined age requirement is saved atomically; previously confirmed age does not need a new checkbox', async () => {
    env.AGE_GATE_MIN_AGE = '13';
    expect(await status()).toMatchObject({ required: true, ageRequired: true });
    expect((await accept()).statusCode).toBe(400);
    expect((await status()).acceptedAt).toBeNull();
    expect((await accept({ ageConfirmed: true })).statusCode).toBe(200);
    expect(await status()).toMatchObject({ required: false, ageRequired: false });
    const age = (await pg.query('SELECT age_confirmed_at FROM users WHERE id=$1', [RIDER])).rows[0].age_confirmed_at;
    env.TERMS_VERSION = 'v2';
    expect((await accept()).statusCode).toBe(200);
    expect((await pg.query('SELECT age_confirmed_at FROM users WHERE id=$1', [RIDER])).rows[0].age_confirmed_at).toEqual(age);
});
test('new signup acceptance uses the same authenticated route and does not require a second agreement', async () => {
    env.AGE_GATE_MIN_AGE = '13';
    expect((await accept({ ageConfirmed: true }, NEW)).statusCode).toBe(200);
    expect(await status(NEW)).toMatchObject({ required: false, ageRequired: false });
    expect((await status()).required).toBe(true);
});
test('rate limit runs before authentication', async () => {
    for (let i = 0; i < 120; i++) expect((await app.inject('/user/terms-acceptance')).statusCode).toBe(401);
    expect((await app.inject('/user/terms-acceptance')).statusCode).toBe(429);
    expect(query).not.toHaveBeenCalled();
});
test('deleted accounts cannot record acceptance; direct Supabase writes cannot forge acceptance', async () => {
    await pg.query('UPDATE users SET deleted_at=now() WHERE id=$1', [NEW]);
    expect((await accept({}, NEW)).statusCode).toBe(401);
    await pg.exec('GRANT USAGE ON SCHEMA public TO authenticated; GRANT SELECT,UPDATE,INSERT ON users TO authenticated; SET ROLE authenticated');
    try {
        await expect(pg.query('UPDATE users SET terms_accepted_at=now(), terms_version_accepted=$1 WHERE id=$2', ['2026-10-01', RIDER])).rejects.toThrow('Compliance fields are managed');
        await expect(pg.query("INSERT INTO users(id,terms_version_accepted) VALUES ('33333333-3333-4333-8333-333333333333','forged')")).rejects.toThrow('Compliance fields are managed');
    } finally { await pg.exec('RESET ROLE'); }
});
