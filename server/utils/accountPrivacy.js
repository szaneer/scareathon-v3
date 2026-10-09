import { accountClosed } from './accountSessions.js';
import { createClient } from '@supabase/supabase-js';
import { clearStandingsCache } from './scareathon.js';
import { deleteCachePrefix } from './cacheManager.js';

export function accountAuth() {
    const url = process.env.SUPABASE_URL || (process.env.SUPABASE_PROJECT_REF && `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`);
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Account controls require Supabase service-role configuration');
    // Each call owns its client: password verification must never replace a shared admin session.
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function requireActiveAccount(db, request, reply) {
    if (!request.user?.sub || request.user.agent) {
        reply.code(401).send({ error: 'Sign in with your account first.' });
        return false;
    }
    const result = await db.query('SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL', [request.user.sub]);
    if (!result.rows[0]) {
        reply.code(401).send({ error: 'This account is closed.' });
        return false;
    }
    return true;
}

// Fixed identifiers only; installations may not yet have every optional game table.
export const PRIVATE_TABLES = [
    'agent_tokens', 'wayside_online_reactions', 'wayside_online_posts',
    'inbox_rewards', 'inbox_participants', 'picto_box_photos',
    'user_outfit_items', 'user_avatar', 'user_inventory', 'item_awards',
    'user_item_instances', 'user_avatar_profile', 'user_wallets',
    'user_banner_choice', 'user_banners', 'user_songs', 'user_carts',
    'scareathon_watches', 'game_specific_data', 'wayside_fury_saves',
    'mystery_crypt_saves', 'scare_capitalist_saves', 'daily_puzzle_plays',
    'casino_rounds', 'monster_bash_bets',
];
export async function existingTables(db) {
    const result = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    return new Set(result.rows.map(row => row.table_name));
}

export async function erasePrivateAccount(client, userId) {
    const user = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw new Error('Account not found');
    if (user.rows[0].deleted_at) return;
    const tables = await existingTables(client);
    // Preserve the movies total, without retaining which nights the rider watched.
    if (tables.has('scareathon_watches')) {
        await client.query(`INSERT INTO scareathon_points (user_id, season, category, points, reason, source_key)
            SELECT user_id, season, 'movies', count(*)::int, '', 'deleted-account:movies'
            FROM scareathon_watches WHERE user_id = $1 GROUP BY user_id, season
            ON CONFLICT (user_id, season, source_key) WHERE source_key IS NOT NULL DO NOTHING`, [userId]);
    }
    if (tables.has('scareathon_points')) {
        await client.query("UPDATE scareathon_points SET reason = '', source_key = NULL, awarded_by = NULL WHERE user_id = $1", [userId]);
        await client.query('UPDATE scareathon_points SET awarded_by = NULL WHERE awarded_by = $1', [userId]);
    }
    for (const table of ['scareathon_history', 'scareathon_winners']) {
        if (tables.has(table)) await client.query(`UPDATE public.${table}
            SET name = 'Deleted rider_' || substr(md5($1::text), 1, 18), user_id = $1
            WHERE user_id = $1 OR (user_id IS NULL AND name = $2)`, [userId, user.rows[0].username]);
    }
    // Remove private conversations including incoming mail; cascades remove messages/rewards.
    if (tables.has('inbox_conversations')) {
        await client.query(`DELETE FROM inbox_conversations WHERE id IN
            (SELECT conversation_id FROM inbox_participants WHERE user_id = $1)
            OR created_by_user_id = $1`, [userId]);
        await client.query('DELETE FROM inbox_messages WHERE sender_user_id = $1', [userId]);
    }
    if (tables.has('marketplace_listings')) {
        // Remove listings before owned copies (the item-instance FK is RESTRICT).
        await client.query(`DELETE FROM marketplace_listings WHERE seller_user_id = $1
            OR item_instance_id IN (SELECT id FROM user_item_instances WHERE user_id = $1)`, [userId]);
        await client.query('UPDATE marketplace_listings SET buyer_user_id = NULL WHERE buyer_user_id = $1', [userId]);
    }
    if (tables.has('currency_transactions')) {
        await client.query('DELETE FROM currency_transactions WHERE user_id = $1', [userId]);
        await client.query("UPDATE currency_transactions SET counterparty_user_id = NULL, metadata = '{}' WHERE counterparty_user_id = $1", [userId]);
    }
    for (const table of PRIVATE_TABLES) {
        if (tables.has(table)) {
            const field = table === 'inbox_rewards' ? 'recipient_user_id' : 'user_id';
            await client.query(`DELETE FROM public.${table} WHERE ${field} = $1`, [userId]);
        }
    }
    // No persistent chat table currently exists; erase one if an installation has added it.
    const chatColumns = await client.query(`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name ~ '(chat|messages)$'
        AND column_name IN ('user_id', 'sender_user_id') AND data_type = 'uuid'`);
    for (const { table_name: table, column_name: column } of chatColumns.rows) {
        // Identifiers come from the DB catalog, quoted even though the filter is narrow.
        const quote = value => '"' + value.replaceAll('"', '""') + '"';
        await client.query(`DELETE FROM public.${quote(table)} WHERE ${quote(column)} = $1`, [userId]);
    }
    if (tables.has('user_blocks')) await client.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
    if (tables.has('content_reports')) {
        await client.query('DELETE FROM content_reports WHERE reporter_id = $1', [userId]);
        await client.query("UPDATE content_reports SET target_user_id = NULL, snapshot = NULL WHERE target_user_id = $1", [userId]);
    }
    if (Object.hasOwn(user.rows[0], 'age_confirmed_at')) {
        await client.query('UPDATE users SET age_confirmed_at = NULL, content_restricted_at = NULL WHERE id = $1', [userId]);
    }
    if (Object.hasOwn(user.rows[0], 'terms_accepted_at')) {
        await client.query('UPDATE users SET terms_accepted_at = NULL, terms_version_accepted = NULL WHERE id = $1', [userId]);
    }
    // Blank any legacy avatar fields as well as the dedicated avatar/outfit tables.
    const legacy = Object.keys(user.rows[0]).filter(key => /^(avatar|outfit)(_|$)/.test(key));
    for (const column of legacy) {
        await client.query(`UPDATE users SET "${column.replaceAll('"', '""')}" = NULL WHERE id = $1`, [userId]);
    }
    await client.query(`UPDATE users SET username = 'Deleted rider_' || substr(md5(id::text), 1, 18),
        email = id::text || '@deleted.invalid', deleted_at = now() WHERE id = $1`, [userId]);
    // Byte-backed PictoBox rows were removed above. Also queue any Storage-backed files,
    // including expired photos, and the legacy avatar composite, before committing.
    const files = await client.query(`SELECT bucket_id, name FROM storage.objects
        WHERE COALESCE(to_jsonb(objects)->>'owner_id', to_jsonb(objects)->>'owner') = $1::text
        OR (bucket_id IN ('avatar-composites', 'picto-box', 'picto-box-photos')
            AND (name = $1::text || '.png' OR name LIKE $1::text || '/%'))`, [userId]);
    await client.query(`INSERT INTO account_deletion_jobs (user_id, storage_files) VALUES ($1, $2::jsonb)
        ON CONFLICT (user_id) DO NOTHING`, [userId, JSON.stringify(files.rows)]);
}

export function clearAccountCaches(userId) {
    if (userId) accountClosed(userId);
    clearStandingsCache();
    deleteCachePrefix('');
}

export async function finishAccountDeletion(db, userId, supabase = accountAuth()) {
    const jobs = await db.query('SELECT storage_files FROM account_deletion_jobs WHERE user_id = $1', [userId]);
    if (!jobs.rows[0]) return;
    const buckets = new Map();
    for (const file of jobs.rows[0].storage_files) {
        const names = buckets.get(file.bucket_id) || [];
        names.push(file.name);
        buckets.set(file.bucket_id, names);
    }
    for (const [bucket, names] of buckets) {
        for (let offset = 0; offset < names.length; offset += 100) {
            const { error } = await supabase.storage.from(bucket).remove(names.slice(offset, offset + 100));
            if (error) throw new Error('Storage cleanup failed');
        }
    }
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error && error.code !== 'user_not_found' && error.status !== 404) throw new Error('Auth cleanup failed');
    await db.query('DELETE FROM account_deletion_jobs WHERE user_id = $1', [userId]);
}

export async function retryAccountDeletions(db, log, auth = accountAuth) {
    const jobs = await db.query('SELECT user_id FROM account_deletion_jobs ORDER BY created_at LIMIT 20');
    for (const { user_id: id } of jobs.rows) {
        try { await finishAccountDeletion(db, id, auth()); }
        catch { log.error('Account cleanup pending; will retry'); }
    }
}
