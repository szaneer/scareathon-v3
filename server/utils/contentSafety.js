import { minimumAge, termsVersion } from './features.js';
import { EventEmitter } from 'node:events';
import { onAccountClosed } from './accountSessions.js';
const changes = new EventEmitter();
export function onContentRemoved(listener) { changes.on('removed', listener); return () => changes.off('removed', listener); }
export function contentRemoved(type, id, userId) { changes.emit('removed', { type, id, userId }); }

// Live chat disappears quickly; remember a bounded server-authored snapshot for reports.
const chats = new Map();
export function rememberChat(type, id, userId, text) {
    const key = `${type}:${id}`;
    const entry = { userId, text, at: Date.now() };
    chats.set(key, entry);
    while (chats.size > 5000) chats.delete(chats.keys().next().value);
    return entry;
}
export function chatTarget(type, id) { return chats.get(`${type}:${id}`) ?? null; }
export function forgetUserChats(userId) {
    for (const [key, target] of chats) if (target.userId === userId) chats.delete(key);
}
onAccountClosed(forgetUserChats);
export function forgetChat(type, id) { chats.delete(`${type}:${id}`); }
export function isContentWrite(method, url) {
    const path = url.split('?')[0];
    return ['POST', 'PUT', 'PATCH'].includes(method) && (
        /^\/wayside-online\/posts(?:\/|$)/.test(path) ||
        path === '/wayside-online/lounge/ticket' || path === '/monster-bash/chat' ||
        path === '/picto-box/photos' || path === '/marketplace/listings' ||
        path === '/inbox/conversations' || /^\/inbox\/conversations\/\d+\/messages$/.test(path)
    );
}
export function createContentGate(db, env = process.env) {
    return async (request, reply) => {
        if (!request.user?.sub || !isContentWrite(request.method, request.url)) return;
        // No extra queries or restrictions until a switch is configured.
        const version = termsVersion(env);
        if (!version && !minimumAge(env) && env.REPORTS_ENABLED !== 'true') return;
        const result = await db.query('SELECT age_confirmed_at, content_restricted_at, terms_accepted_at, terms_version_accepted FROM users WHERE id = $1 AND deleted_at IS NULL', [request.user.sub]);
        const user = result.rows[0];
        if (version && (!user?.terms_accepted_at || user.terms_version_accepted !== version)) return reply.code(403).send({ code: 'terms_acceptance_required', error: 'Please agree to the house rules on the station notice before sharing. You can still read and play.' });
        if (minimumAge(env) && !user?.age_confirmed_at) return reply.code(403).send({ code: 'age_confirmation_required', error: 'Please confirm your age at the ticket counter before sharing content.' });
        if (env.REPORTS_ENABLED === 'true' && user?.content_restricted_at) return reply.code(403).send({ code: 'content_restricted', error: 'Your account is restricted from sharing content.' });
    };
}
export async function blockedUsers(db, viewer, env = process.env) {
    if (!viewer || env.REPORTS_ENABLED !== 'true') return new Set();
    const result = await db.query('SELECT blocked_id FROM user_blocks WHERE blocker_id = $1', [viewer]);
    return new Set(result.rows.map(row => row.blocked_id));
}
export async function canMessage(db, sender, recipient, env = process.env) {
    if (env.REPORTS_ENABLED !== 'true') return true;
    const result = await db.query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [sender, recipient]);
    return result.rows.length === 0;
}
