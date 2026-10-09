import { jest } from '@jest/globals';
import Fastify from 'fastify';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const query = jest.fn();
const release = jest.fn();
const db = { query, connect: async () => ({ query, release }) };
jest.unstable_mockModule('../db/mockDB.js', () => ({ default: db }));
const { default: routes } = await import('../routes/compliance.js');
const { createGeoHook, startGeoDatabase } = await import('../utils/geo.js');
const { createContentGate, canMessage, blockedUsers, rememberChat, chatTarget, onContentRemoved } = await import('../utils/contentSafety.js');
const { publicFeatures } = await import('../utils/features.js');
const { isPublicRoute } = await import('../utils/authRoutes.js');
const { registerComplianceRateLimits } = await import('../utils/complianceRateLimits.js');
const RIDER = '11111111-1111-4111-8111-111111111111';
const AUTHOR = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const PHOTO = '44444444-4444-4444-8444-444444444444';
const apps = [];
const row = value => ({ rows: value ? [value] : [], rowCount: value ? 1 : 0 });
const headers = { 'x-rider': RIDER };
async function build(env = {}, geo = null) {
    const app = Fastify(); apps.push(app);
    app.decorateRequest('user', null);
    if (geo) app.addHook('onRequest', createGeoHook(geo));
    app.addHook('preValidation', async (request, reply) => {
        if (isPublicRoute(request.method, request.url)) return;
        if (!request.headers['x-rider']) return reply.code(401).send({ error: 'Sign in' });
        request.user = { sub: request.headers['x-rider'] };
    });
    await registerComplianceRateLimits(app);
    app.addHook('preHandler', createContentGate(db, env));
    await app.register(routes, { db, env, geoReady: () => true });
    for (const url of ['/picto-box/photos', '/wayside-online/posts', '/wayside-online/lounge/ticket', '/monster-bash/chat', '/marketplace/listings', '/inbox/conversations', '/inbox/conversations/1/messages']) app.post(url, async () => ({ shared: true }));
    app.get('/health', async () => ({ ok: true }));
    app.get('/user/export', async () => ({ data: true }));
    app.delete('/user/account', async () => ({ deleted: true }));
    return app;
}
beforeEach(() => { query.mockReset(); query.mockResolvedValue(row()); process.env.ADMIN_USER_IDS = ADMIN; });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); delete process.env.ADMIN_USER_IDS; });

describe('geo onRequest hook', () => {
    test('no env does not lookup or change traffic', async () => {
        const lookup = jest.fn(() => ({ country: { iso_code: 'GB' } }));
        const app = await build({}, { env: {}, lookup, ready: () => true });
        expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers })).statusCode).toBe(200);
        expect(lookup).not.toHaveBeenCalled();
    });
    test('blocks non-allowlisted country, allows allowed and unknown countries', async () => {
        let country = 'GB';
        const app = await build({}, { env: { GEO_ALLOWED_COUNTRIES: 'us, CA' }, ready: () => true, lookup: () => ({ country: { iso_code: country } }) });
        let response = await app.inject({ method: 'POST', url: '/picto-box/photos', headers });
        expect(response.statusCode).toBe(451); expect(response.json().code).toBe('region_unavailable');
        for (country of ['US', 'CA', undefined]) expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers })).statusCode).toBe(200);
    });
    test('bypass token, health, feature config, export, delete and preflight stay available', async () => {
        const app = await build({}, { env: { GEO_ALLOWED_COUNTRIES: 'US', GEO_BYPASS_TOKEN: 'private-token' }, ready: () => true, lookup: () => ({ country: { iso_code: 'GB' } }) });
        expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers: { ...headers, 'x-ws-geo-bypass': 'private-token' } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers: { ...headers, 'x-ws-geo-bypass': 'wrong' } })).statusCode).toBe(451);
        for (const url of ['/health', '/config/features', '/user/export']) expect((await app.inject({ url, headers })).statusCode).toBe(200);
        expect((await app.inject({ method: 'DELETE', url: '/user/account', headers })).statusCode).toBe(200);
    });
    test('fails open with missing DB or lookup error', async () => {
        for (const ready of [() => false, () => true]) {
            const app = await build({}, { env: { GEO_ALLOWED_COUNTRIES: 'US' }, ready, lookup: () => { throw new Error('bad database'); } });
            expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers })).statusCode).toBe(200);
        }
    });
    test('startup refreshes a week-old cache using the downloaded archive', async () => {
        const { c } = await import('tar');
        const directory = await mkdtemp(join(tmpdir(), 'station-geo-refresh-'));
        let geo;
        try {
            const source = join(directory, 'source');
            await mkdir(join(source, 'GeoLite2-Country_20261009'), { recursive: true });
            await writeFile(join(source, 'GeoLite2-Country_20261009', 'GeoLite2-Country.mmdb'), 'CA');
            const chunks = []; for await (const chunk of c({ gzip: true, cwd: source }, ['GeoLite2-Country_20261009/GeoLite2-Country.mmdb'])) chunks.push(chunk);
            const archive = Buffer.concat(chunks);
            const database = join(directory, 'GeoLite2-Country.mmdb');
            await writeFile(database, 'US'); const old = new Date(Date.now() - 8 * 24 * 60 * 60_000); await utimes(database, old, old);
            const download = jest.fn(async () => new Response(archive));
            geo = await startGeoDatabase({ warn: jest.fn() }, {
                env: { GEO_ALLOWED_COUNTRIES: 'US', MAXMIND_LICENSE_KEY: 'secret', MAXMIND_ACCOUNT_ID: '123', GEO_DATABASE_CACHE_DIR: directory },
                open: async path => { const country = await readFile(path, 'utf8'); return { get: () => ({ country: { iso_code: country } }) }; }, download,
            });
            expect(download).toHaveBeenCalledTimes(1); expect(geo.lookup('1.2.3.4').country.iso_code).toBe('CA');
            expect(await readFile(database, 'utf8')).toBe('CA');
            expect(download.mock.calls[0][1].headers.Authorization).toContain('Basic ');
        } finally { geo?.close(); await rm(directory, { recursive: true, force: true }); }
    });
    test('startup without a usable DB warns and remains open; cached DB survives download failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'station-geo-'));
        const log = { warn: jest.fn() };
        try {
            let geo = await startGeoDatabase(log, { env: { GEO_ALLOWED_COUNTRIES: 'US', GEO_DATABASE_CACHE_DIR: directory }, open: async () => { throw new Error('missing'); } });
            expect(geo.ready()).toBe(false); expect(log.warn).toHaveBeenCalled(); geo.close();
            geo = await startGeoDatabase(log, { env: { GEO_ALLOWED_COUNTRIES: 'US', MAXMIND_LICENSE_KEY: 'secret', GEO_DATABASE_CACHE_DIR: directory }, open: async () => ({ get: () => ({ country: { iso_code: 'US' } }) }), download: async () => { throw new Error('license=secret'); } });
            expect(geo.ready()).toBe(true); expect(geo.lookup('127.0.0.1').country.iso_code).toBe('US');
            expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret'); geo.close();
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});

describe('features and age gate', () => {
    test('public cached config is dormant by default and exposes no secrets', async () => {
        const app = await build();
        const response = await app.inject('/config/features?fresh=1');
        expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('public, max-age=60');
        expect(response.json()).toEqual({ geoBlock: false, geoAllowedCountries: [], ageGate: false, ageGateMinAge: null, termsAcceptance: false, termsVersion: null, reports: false, legalContactEmail: null, legalOwnerName: null, accountDeletion: false, emailChange: true });
        const active = publicFeatures({ AGE_GATE_MIN_AGE: '13', GEO_ALLOWED_COUNTRIES: 'US,ca', REPORTS_ENABLED: 'true', SUPABASE_SERVICE_KEY: 'secret', GEO_BYPASS_TOKEN: 'bypass', LEGAL_CONTACT_EMAIL: 'owner@example.com', LEGAL_OWNER_NAME: 'Owner', EMAIL_CHANGE_ENABLED: 'false' }, true);
        expect(active).toMatchObject({ geoBlock: true, ageGate: true, reports: true, accountDeletion: true, emailChange: false });
        expect(JSON.stringify(active)).not.toMatch(/secret|bypass/);
    });
    test('env changes turn features on without changing code; invalid settings stay off', async () => {
        const env = {}; const app = await build(env);
        env.REPORTS_ENABLED = 'true'; env.AGE_GATE_MIN_AGE = '13';
        expect((await app.inject('/config/features')).json()).toMatchObject({ reports: true, ageGate: true });
        for (const value of ['', 'abc', '0', '12', '13.5']) expect(publicFeatures({ AGE_GATE_MIN_AGE: value }).ageGate).toBe(false);
    });
    test('age off adds no query and no content restrictions', async () => {
        const app = await build();
        expect((await app.inject({ url: '/user/age-confirmation', headers })).json().required).toBe(false);
        expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers })).statusCode).toBe(200);
        expect(query).not.toHaveBeenCalled();
    });
    test('age on prompts once, records server time, and gates every content route', async () => {
        let confirmed = false;
        query.mockImplementation(async sql => {
            if (sql.startsWith('UPDATE users SET age_confirmed_at')) confirmed = true;
            return row({ age_confirmed_at: confirmed ? '2026-10-09T19:00:00Z' : null, content_restricted_at: null });
        });
        const app = await build({ AGE_GATE_MIN_AGE: '13' });
        expect((await app.inject({ url: '/user/age-confirmation', headers })).json().required).toBe(true);
        for (const url of ['/picto-box/photos', '/wayside-online/posts', '/wayside-online/lounge/ticket', '/monster-bash/chat', '/marketplace/listings', '/inbox/conversations', '/inbox/conversations/1/messages']) expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/user/age-confirmation', headers, payload: { confirmed: false } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/user/age-confirmation', headers, payload: { confirmed: true } })).json().confirmedAt).toBeTruthy();
        expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE users'))[0]).toContain('COALESCE(age_confirmed_at, now())');
        expect((await app.inject({ url: '/user/age-confirmation', headers })).json().required).toBe(false);
        expect((await app.inject({ method: 'POST', url: '/picto-box/photos', headers })).statusCode).toBe(200);
    });
});

describe('reports and blocks', () => {
    test('off by default; authenticated and admin routes remain protected', async () => {
        const off = await build();
        expect((await off.inject({ url: '/user/blocks', headers })).statusCode).toBe(404);
        const on = await build({ REPORTS_ENABLED: 'true' });
        expect((await on.inject('/user/blocks')).statusCode).toBe(401);
        expect((await on.inject({ url: '/admin/content-reports', headers })).statusCode).toBe(403);
    });
    test('reports each supported target with a trusted server snapshot', async () => {
        query.mockImplementation(async sql => sql.includes('INSERT INTO content_reports') ? row({ id: '1', status: 'pending' }) : row({ user_id: AUTHOR, content: 'server content' }));
        const app = await build({ REPORTS_ENABLED: 'true' });
        rememberChat('lounge_chat', 'lounge-1', AUTHOR, 'lounge words'); rememberChat('monster_chat', 'monster-1', AUTHOR, 'monster words');
        for (const [targetType, targetId] of [['post', '1'], ['photo', PHOTO], ['listing', '3'], ['lounge_chat', 'lounge-1'], ['monster_chat', 'monster-1']]) {
            const response = await app.inject({ method: 'POST', url: '/content/reports', headers, payload: { targetType, targetId, reason: 'Harassment', targetUserId: RIDER, snapshot: 'forged' } });
            expect(response.statusCode).toBe(201);
            const args = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO content_reports')).at(-1)[1];
            expect(args[3]).toBe(AUTHOR); expect(args[5]).not.toContain('forged');
        }
        expect((await app.inject({ method: 'POST', url: '/content/reports', headers, payload: { targetType: 'unknown', targetId: '1', reason: 'x' } })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url: '/content/reports', headers, payload: { targetType: 'post', targetId: '1', reason: ' ' } })).statusCode).toBe(400);
    });
    test.each(['post', 'photo', 'listing', 'lounge_chat', 'monster_chat'])('admin removes %s and can restrict its author', async type => {
        rememberChat(type, '1', AUTHOR, 'words');
        query.mockImplementation(async sql => {
            if (sql.startsWith('SELECT * FROM content_reports')) return row({ id: '7', target_type: type, target_id: '1', target_user_id: AUTHOR });
            if (sql.includes('RETURNING item_instance_id')) return row({ item_instance_id: 8, seller_user_id: AUTHOR });
            return row();
        });
        const removed = jest.fn(); const stop = onContentRemoved(removed);
        try {
            const app = await build({ REPORTS_ENABLED: 'true' });
            const response = await app.inject({ method: 'POST', url: '/admin/content-reports/7/review', headers: { 'x-rider': ADMIN }, payload: { action: 'remove', restrictUser: true } });
            expect(response.statusCode).toBe(200); expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
            expect(query.mock.calls.some(([sql]) => sql.includes('content_restricted_at'))).toBe(true);
            expect(removed).toHaveBeenCalledWith({ type, id: '1', userId: AUTHOR });
            if (type.includes('chat')) expect(chatTarget(type, '1')).toBeNull();
        } finally { stop(); }
    });
    test('admin queue and dismissal; rollback does not broadcast removal', async () => {
        query.mockImplementation(async sql => sql.includes('SELECT * FROM content_reports') ? row({ id: '7', target_type: 'post', target_id: '1', target_user_id: AUTHOR }) : row());
        const app = await build({ REPORTS_ENABLED: 'true' });
        expect((await app.inject({ url: '/admin/content-reports', headers: { 'x-rider': ADMIN } })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/admin/content-reports/7/review', headers: { 'x-rider': ADMIN }, payload: { action: 'dismiss' } })).statusCode).toBe(200);
        expect(query.mock.calls.some(([sql]) => sql.includes('removed_at'))).toBe(false);
        query.mockImplementation(async sql => { if (sql.includes('SELECT * FROM content_reports')) return row({ id: '7', target_type: 'post', target_id: '1' }); if (sql.includes('UPDATE wayside_online_posts')) throw new Error('db down'); return row(); });
        const listener = jest.fn(); const stop = onContentRemoved(listener);
        try {
            expect((await app.inject({ method: 'POST', url: '/admin/content-reports/7/review', headers: { 'x-rider': ADMIN }, payload: { action: 'remove' } })).statusCode).toBe(500);
            expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true); expect(listener).not.toHaveBeenCalled();
        } finally { stop(); }
    });
    test('block, list and unblock; either direction stops direct messages; off adds no query', async () => {
        let blocked = false;
        query.mockImplementation(async sql => {
            if (sql.includes('INSERT INTO user_blocks')) blocked = true;
            if (sql.includes('DELETE FROM user_blocks')) blocked = false;
            if (sql.includes('SELECT id FROM users')) return row({ id: AUTHOR });
            if (sql.includes('FROM user_blocks')) return blocked ? row({ blocked_id: AUTHOR, userId: AUTHOR }) : row();
            return row();
        });
        const env = { REPORTS_ENABLED: 'true' }; const app = await build(env);
        expect((await app.inject({ method: 'PUT', url: `/user/blocks/${RIDER}`, headers })).statusCode).toBe(400);
        expect((await app.inject({ method: 'PUT', url: `/user/blocks/${AUTHOR}`, headers })).json().blocked).toBe(true);
        expect((await app.inject({ url: '/user/blocks', headers })).json().blocks[0].userId).toBe(AUTHOR);
        expect(await blockedUsers(db, RIDER, env)).toEqual(new Set([AUTHOR]));
        expect(await canMessage(db, AUTHOR, RIDER, env)).toBe(false);
        expect(query.mock.calls.at(-1)[0]).toContain('OR (blocker_id = $2 AND blocked_id = $1)');
        expect((await app.inject({ method: 'DELETE', url: `/user/blocks/${AUTHOR}`, headers })).json().blocked).toBe(false);
        expect(await canMessage(db, AUTHOR, RIDER, env)).toBe(true);
        query.mockClear(); expect(await canMessage(db, AUTHOR, RIDER, {})).toBe(true); expect(query).not.toHaveBeenCalled();
    });
    test('restrictions apply only with reports on; account access stays available', async () => {
        query.mockResolvedValue(row({ age_confirmed_at: 'now', content_restricted_at: 'now' }));
        const on = await build({ REPORTS_ENABLED: 'true' });
        expect((await on.inject({ method: 'POST', url: '/monster-bash/chat', headers })).statusCode).toBe(403);
        expect((await on.inject({ url: '/user/export', headers })).statusCode).toBe(200);
        const off = await build();
        expect((await off.inject({ method: 'POST', url: '/monster-bash/chat', headers })).statusCode).toBe(200);
    });
    test('sign-in-adjacent unauthenticated failures are limited before authentication', async () => {
        const app = await build();
        for (let count = 0; count < 120; count++) expect((await app.inject('/user/age-confirmation')).statusCode).toBe(401);
        expect((await app.inject('/user/age-confirmation')).statusCode).toBe(429);
        expect(query).not.toHaveBeenCalled();
    });
    test('reports and export/delete always have route rate limits', async () => {
        const app = await build({ REPORTS_ENABLED: 'true' });
        query.mockImplementation(async sql => sql.includes('INSERT INTO content_reports') ? row({ id: 1 }) : row({ user_id: AUTHOR, content: 'words' }));
        for (let count = 0; count < 20; count++) expect((await app.inject({ method: 'POST', url: '/content/reports', headers, payload: { targetType: 'post', targetId: '1', reason: 'x' } })).statusCode).toBe(201);
        expect((await app.inject({ method: 'POST', url: '/content/reports', headers, payload: { targetType: 'post', targetId: '1', reason: 'x' } })).statusCode).toBe(429);
        for (const [method, url] of [['GET', '/user/export'], ['DELETE', '/user/account']]) {
            for (let count = 0; count < 10; count++) expect((await app.inject({ method, url, headers })).statusCode).toBe(200);
            expect((await app.inject({ method, url, headers })).statusCode).toBe(429);
        }
    });
});

describe('integration with existing content and inbox routes', () => {
    let previous;
    beforeEach(() => { previous = process.env.REPORTS_ENABLED; process.env.REPORTS_ENABLED = 'true'; });
    afterEach(() => { if (previous === undefined) delete process.env.REPORTS_ENABLED; else process.env.REPORTS_ENABLED = previous; });
    async function contentApp() {
        const app = Fastify(); apps.push(app);
        app.decorateRequest('user', null);
        app.addHook('preValidation', async request => { request.user = { sub: RIDER }; });
        const { default: posts } = await import('../routes/waysideOnline.js');
        const { default: photos } = await import('../routes/pictoBox.js');
        const { default: inbox } = await import('../routes/inbox.js');
        await app.register(posts, { prefix: '/wayside-online' }); await app.register(photos, { prefix: '/picto-box' }); await app.register(inbox, { prefix: '/inbox' });
        return app;
    }
    test('blocked posts and photos disappear from actual API responses', async () => {
        query.mockImplementation(async sql => {
            if (sql.includes('SELECT blocked_id')) return row({ blocked_id: AUTHOR });
            if (sql.includes('FROM public.wayside_online_reactions')) return row();
            return { rows: [{ id: '1', user_id: AUTHOR, board: 'general', body: 'hidden' }, { id: '2', user_id: RIDER, board: 'general', body: 'visible' }] };
        });
        const app = await contentApp();
        const board = (await app.inject('/wayside-online/threads')).json(); expect(board.threads.map(post => post.id)).toEqual(['2']);
        const photos = (await app.inject('/picto-box/photos')).json(); expect(photos.photos.map(photo => photo.id)).toEqual(['2']);
    });
    test('blocked rider cannot start a DM or reply in an existing conversation', async () => {
        query.mockImplementation(async sql => {
            if (sql.includes('SELECT id, username') && sql.includes('FROM users')) return row({ id: AUTHOR, username: 'Author' });
            if (sql.includes('SELECT c.id, c.replies_enabled')) return row({ id: 1, replies_enabled: true });
            if (sql.includes('SELECT user_id FROM inbox_participants')) return row({ user_id: AUTHOR });
            if (sql.includes('FROM user_blocks')) return row({ blocked_id: RIDER });
            return row();
        });
        const app = await contentApp();
        expect((await app.inject({ method: 'POST', url: '/inbox/conversations', payload: { recipientUsername: 'Author', body: 'not delivered' } })).statusCode).toBe(403);
        expect((await app.inject({ method: 'POST', url: '/inbox/conversations/1/messages', payload: { body: 'not delivered' } })).statusCode).toBe(403);
        expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO inbox_messages'))).toBe(false);
    });
    test('live chats expose server-owned report ids and can be removed', async () => {
        const { createLounge } = await import('../waysideOnline/lounge.js');
        const { createChatRoom } = await import('../monsterBash/chatRoom.js');
        const chat = createChatRoom({ lookupUsername: async () => 'Author' });
        const message = await chat.post(AUTHOR, 'Hello');
        expect(message.userId).toBe(AUTHOR); expect(chatTarget('monster_chat', message.reportId).text).toBe('Hello');
        chat.removeReport(message.reportId); expect(chat.recent()).toEqual([]);
        const sent = []; const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
        const lounge = createLounge(); lounge.watch(socket); lounge.join(socket, { ticket: lounge.ticket({ userId: AUTHOR, name: 'Author' }) }); lounge.say(socket, { text: 'Hi' });
        const said = sent.find(message => message.type === 'say'); expect(chatTarget('lounge_chat', said.sayId).userId).toBe(AUTHOR);
        lounge.removeReport(said.sayId); expect(sent.at(-1)).toMatchObject({ type: 'say', say: null }); lounge.close();
    });
});

test('missing service key disables the real deletion route before any erasure', async () => {
    const saved = [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SUPABASE_SERVICE_KEY];
    delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_KEY;
    try {
        const { default: accountRoutes } = await import('../routes/accountPrivacy.js');
        const app = Fastify(); apps.push(app);
        app.decorateRequest('user', null); app.addHook('preValidation', async request => { request.user = { sub: RIDER }; });
        await app.register(accountRoutes, { prefix: '/user' });
        const response = await app.inject({ method: 'DELETE', url: '/user/account', payload: { confirmation: 'DELETE', currentPassword: 'password' } });
        expect(response.statusCode).toBe(503); expect(response.json().error).toContain('coming soon'); expect(query).not.toHaveBeenCalled();
    } finally {
        for (const [key, value] of [['SUPABASE_SERVICE_ROLE_KEY', saved[0]], ['SUPABASE_SERVICE_KEY', saved[1]]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
