import pool from '../db/mockDB.js';
import { isAdminUser } from './inbox.js';
import { publicFeatures, minimumAge, termsVersion } from '../utils/features.js';
import { chatTarget, contentRemoved, forgetChat } from '../utils/contentSafety.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGETS = {
    post: { table: 'wayside_online_posts', author: 'user_id', content: 'body' },
    photo: { table: 'picto_box_photos', author: 'user_id', content: 'style' },
    listing: { table: 'marketplace_listings', author: 'seller_user_id', content: 'status' },
};
async function targetFor(db, type, id) {
    if (type === 'lounge_chat' || type === 'monster_chat') return chatTarget(type, id);
    const target = Object.hasOwn(TARGETS, type) ? TARGETS[type] : null;
    if (!target || !(type === 'photo' ? UUID.test(id) : /^[1-9]\d{0,18}$/.test(id))) return null;
    const result = await db.query(`SELECT ${target.author} AS user_id, ${target.content} AS content FROM ${target.table} WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? { userId: row.user_id, text: row.content } : null;
}
export default async function complianceRoutes(fastify, { db = pool, env = process.env, geoReady = () => false } = {}) {
    fastify.get('/config/features', async (_request, reply) => reply.header('Cache-Control', 'public, max-age=60').send(publicFeatures(env, geoReady())));
    fastify.get('/user/terms-acceptance', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const version = termsVersion(env);
        if (!version) return { required: false, currentVersion: null, acceptedAt: null, versionAccepted: null, ageRequired: false };
        const { rows } = await db.query('SELECT terms_accepted_at, terms_version_accepted, age_confirmed_at FROM users WHERE id = $1 AND deleted_at IS NULL', [request.user.sub]);
        const user = rows[0];
        if (!user) return reply.code(401).send({ error: 'Sign in again.' });
        return { required: !user.terms_accepted_at || user.terms_version_accepted !== version, currentVersion: version,
            acceptedAt: user.terms_accepted_at, versionAccepted: user.terms_version_accepted,
            ageRequired: Boolean(minimumAge(env) && !user.age_confirmed_at) };
    });
    fastify.post('/user/terms-acceptance', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const version = termsVersion(env);
        if (!version) return { required: false, currentVersion: null };
        if (request.body?.accepted !== true) return reply.code(400).send({ error: 'Choose I agree to accept the house rules.' });
        if (request.body.version !== version) return reply.code(409).send({ code: 'terms_version_changed', error: 'The house rules have changed. Please read the current papers and agree again.' });
        const age = minimumAge(env);
        if (age && request.body.ageConfirmed !== true) {
            const { rows } = await db.query('SELECT age_confirmed_at FROM users WHERE id = $1 AND deleted_at IS NULL', [request.user.sub]);
            if (!rows[0]?.age_confirmed_at) return reply.code(400).send({ error: `Confirm that you are ${age} or older.` });
        }
        const { rows } = await db.query(`UPDATE users SET
            terms_accepted_at = CASE WHEN terms_version_accepted = $2 THEN COALESCE(terms_accepted_at, now()) ELSE now() END,
            terms_version_accepted = $2,
            age_confirmed_at = CASE WHEN $3::boolean THEN COALESCE(age_confirmed_at, now()) ELSE age_confirmed_at END
            WHERE id = $1 AND deleted_at IS NULL RETURNING terms_accepted_at, terms_version_accepted`,
        [request.user.sub, version, Boolean(age && request.body.ageConfirmed === true)]);
        if (!rows.length) return reply.code(401).send({ error: 'Sign in again.' });
        return { required: false, currentVersion: version, acceptedAt: rows[0].terms_accepted_at, versionAccepted: rows[0].terms_version_accepted, ageRequired: false };
    });
    fastify.get('/user/age-confirmation', async (request) => {
        if (!minimumAge(env)) return { required: false, confirmedAt: null };
        const result = await db.query('SELECT age_confirmed_at FROM users WHERE id = $1', [request.user.sub]);
        return { required: !result.rows[0]?.age_confirmed_at, confirmedAt: result.rows[0]?.age_confirmed_at ?? null };
    });
    fastify.post('/user/age-confirmation', async (request, reply) => {
        if (!minimumAge(env)) return { required: false };
        if (request.body?.confirmed !== true) return reply.code(400).send({ error: `Confirm that you are ${minimumAge(env)} or older.` });
        const result = await db.query('UPDATE users SET age_confirmed_at = COALESCE(age_confirmed_at, now()) WHERE id = $1 AND deleted_at IS NULL RETURNING age_confirmed_at', [request.user.sub]);
        if (!result.rows.length) return reply.code(401).send({ error: 'Sign in again.' });
        return { required: false, confirmedAt: result.rows[0].age_confirmed_at };
    });
    const enabled = async (_request, reply) => {
        if (env.REPORTS_ENABLED !== 'true') return reply.code(404).send({ error: 'This feature is not available yet.' });
    };
    const admin = async (request, reply) => {
        if (env.REPORTS_ENABLED !== 'true') return reply.code(404).send({ error: 'This feature is not available yet.' });
        if (!isAdminUser(request.user)) return reply.code(403).send({ error: 'Admins only.' });
    };
    fastify.post('/content/reports', { preHandler: enabled, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (request, reply) => {
        const { targetType, targetId, reason } = request.body || {};
        if (typeof targetType !== 'string' || typeof targetId !== 'string' || targetId.length > 100 || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) return reply.code(400).send({ error: 'Choose content and give a reason (up to 1000 characters).' });
        const target = await targetFor(db, targetType, targetId);
        if (!target) return reply.code(404).send({ error: 'That content is no longer available.' });
        if (targetType.endsWith('_chat')) {
            const author = await db.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL', [target.userId]);
            if (!author.rows.length) return reply.code(404).send({ error: 'That content is no longer available.' });
        }
        const result = await db.query(`INSERT INTO content_reports (reporter_id, target_type, target_id, target_user_id, reason, snapshot)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, status`, [request.user.sub, targetType, targetId, target.userId, reason.trim(), JSON.stringify({ text: target.text })]);
        return reply.code(201).send({ report: result.rows[0] });
    });
    fastify.get('/user/blocks', { preHandler: enabled }, async request => ({ blocks: (await db.query('SELECT blocked_id AS "userId", created_at AS "createdAt" FROM user_blocks WHERE blocker_id = $1', [request.user.sub])).rows }));
    fastify.put('/user/blocks/:id', { preHandler: enabled }, async (request, reply) => {
        const id = request.params.id;
        if (!UUID.test(id) || id === request.user.sub) return reply.code(400).send({ error: 'Choose another rider.' });
        const exists = await db.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
        if (!exists.rows.length) return reply.code(404).send({ error: 'No such rider.' });
        await db.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.user.sub, id]);
        return { blocked: true };
    });
    fastify.delete('/user/blocks/:id', { preHandler: enabled }, async (request, reply) => {
        if (!UUID.test(request.params.id)) return reply.code(400).send({ error: 'Choose a rider.' });
        await db.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [request.user.sub, request.params.id]);
        return { blocked: false };
    });
    fastify.get('/admin/content-reports', { preHandler: admin }, async () => ({ reports: (await db.query(`SELECT r.*, u.username AS target_username FROM content_reports r
        LEFT JOIN users u ON u.id = r.target_user_id WHERE r.status = 'pending' ORDER BY r.created_at LIMIT 100`)).rows }));
    fastify.post('/admin/content-reports/:id/review', { preHandler: admin }, async (request, reply) => {
        const { action, restrictUser = false } = request.body || {};
        if (!/^[1-9]\d*$/.test(request.params.id) || !['dismiss', 'remove'].includes(action) || typeof restrictUser !== 'boolean') return reply.code(400).send({ error: 'Choose dismiss or remove.' });
        const client = await db.connect();
        let removed;
        try {
            await client.query('BEGIN');
            const report = (await client.query("SELECT * FROM content_reports WHERE id = $1 AND status = 'pending' FOR UPDATE", [request.params.id])).rows[0];
            if (!report) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Report already reviewed or missing.' }); }
            if (action === 'remove') {
                if (report.target_type === 'post') await client.query('UPDATE wayside_online_posts SET removed_at = COALESCE(removed_at, now()) WHERE id = $1', [report.target_id]);
                else if (report.target_type === 'photo') await client.query('DELETE FROM picto_box_photos WHERE id = $1', [report.target_id]);
                else if (report.target_type === 'listing') {
                    const listing = (await client.query("UPDATE marketplace_listings SET status = 'canceled', canceled_at = now(), updated_at = now() WHERE id = $1 AND status = 'active' RETURNING item_instance_id, seller_user_id", [report.target_id])).rows[0];
                    if (listing) await client.query("UPDATE user_item_instances SET status = 'owned', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'listed'", [listing.item_instance_id, listing.seller_user_id]);
                }
                if (restrictUser && report.target_user_id) await client.query('UPDATE users SET content_restricted_at = now() WHERE id = $1', [report.target_user_id]);
                removed = report;
            }
            await client.query('UPDATE content_reports SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1', [report.id, action === 'dismiss' ? 'dismissed' : 'removed', request.user.sub]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
        if (removed) { forgetChat(removed.target_type, removed.target_id); contentRemoved(removed.target_type, removed.target_id, restrictUser ? removed.target_user_id : null); }
        return { reviewed: true };
    });
}
