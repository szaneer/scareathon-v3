import pool from '../db/mockDB.js';
import { deletionEnabled } from '../utils/features.js';
import { accountAuth, clearAccountCaches, erasePrivateAccount, existingTables, finishAccountDeletion, requireActiveAccount } from '../utils/accountPrivacy.js';

export default async function accountPrivacyRoutes(fastify, options) {
    const db = options.db || pool;
    const auth = options.accountAuth || accountAuth;
    fastify.get('/export', async (request, reply) => {
        if (!await requireActiveAccount(db, request, reply)) return;
        const client = await db.connect();
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const userId = request.user.sub;
            const tables = await existingTables(client);
            const own = async (table, columns = '*', field = 'user_id') => tables.has(table)
                ? (await client.query(`SELECT ${columns} FROM public.${table} WHERE ${field} = $1`, [userId])).rows : [];
            const profile = (await client.query("SELECT id, username, email, to_jsonb(users)->'created_at' AS created_at, to_jsonb(users)->'terms_accepted_at' AS terms_accepted_at, to_jsonb(users)->'terms_version_accepted' AS terms_version_accepted FROM users WHERE id = $1", [userId])).rows[0];
            // Auth is the source of truth for email (including accounts predating the sync trigger).
            const supabase = auth();
            const { data, error } = await supabase.auth.admin.getUserById(userId);
            if (error || !data.user) throw new Error('Could not read account email');
            const photos = await own('picto_box_photos', 'id, style, created_at');
            const payload = {
                exportedAt: new Date().toISOString(),
                blocks: await own('user_blocks', '*', 'blocker_id'),
                reports: await own('content_reports', 'id, target_type, target_id, reason, created_at, status', 'reporter_id'),
                profile: { ...profile, email: data.user.email }, email: data.user.email,
                wallet: (await own('user_wallets'))[0] || null,
                transactions: await own('currency_transactions'),
                items: await own('user_item_instances'),
                inventory: await own('user_inventory'),
                avatar: await own('user_avatar_profile'), outfit: await own('user_outfit_items'),
                scores: await own('leaderboards'), standings: await own('scareathon_points'),
                watches: await own('scareathon_watches'), posts: await own('wayside_online_posts'),
                photos: photos.map(photo => ({ ...photo, url: `/picto-box/photos/${photo.id}.jpg` })),
                listings: tables.has('marketplace_listings') ? (await client.query('SELECT * FROM marketplace_listings WHERE seller_user_id = $1 OR buyer_user_id = $1', [userId])).rows : [],
                carts: await own('user_carts'), banners: await own('user_banners'), songs: await own('user_songs'),
                inbox: tables.has('inbox_messages') ? (await client.query(`SELECT m.* FROM inbox_messages m
                    JOIN inbox_participants p ON p.conversation_id = m.conversation_id WHERE p.user_id = $1`, [userId])).rows : [],
                inboxConversations: tables.has('inbox_conversations') ? (await client.query(`SELECT c.* FROM inbox_conversations c
                    JOIN inbox_participants p ON p.conversation_id = c.id WHERE p.user_id = $1`, [userId])).rows : [],
                inboxParticipants: await own('inbox_participants'),
                inboxRewards: await own('inbox_rewards', '*', 'recipient_user_id'),
                reactions: await own('wayside_online_reactions'),
                legacyAvatar: await own('user_avatar'), bannerChoice: await own('user_banner_choice'),
                gameData: await own('game_specific_data'),
                saves: { fury: await own('wayside_fury_saves'), mysteryCrypt: await own('mystery_crypt_saves'), scareCapitalist: await own('scare_capitalist_saves') },
                dailyPlays: await own('daily_puzzle_plays'), casinoRounds: await own('casino_rounds'), bets: await own('monster_bash_bets'),
                agentKeys: await own('agent_tokens', 'name, created_at, last_used_at, revoked_at'),
            };
            await client.query('COMMIT');
            return reply.header('Cache-Control', 'no-store')
                .header('Content-Disposition', 'attachment; filename="wayside-station-data.json"').send(payload);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            fastify.log.error('Account export failed');
            return reply.code(503).send({ error: 'Could not download your data. Please try again.' });
        } finally { client.release(); }
    });

    fastify.delete('/account', async (request, reply) => {
        if (!options.accountAuth && !deletionEnabled()) return reply.code(503).send({ error: 'Account closure is coming soon.' });
        if (!await requireActiveAccount(db, request, reply)) return;
        const { confirmation, currentPassword } = request.body || {};
        if (confirmation !== 'DELETE' || typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024) {
            return reply.code(400).send({ error: 'Type DELETE and enter your current password.' });
        }
        let client;
        let committed = false;
        try {
            const supabase = auth();
            const { data, error } = await supabase.auth.admin.getUserById(request.user.sub);
            if (error || !data.user?.email) return reply.code(401).send({ error: 'Could not verify your account.' });
            // A separate, stateless client; never mutate the service-role client's auth state.
            const verifier = auth();
            const verified = await verifier.auth.signInWithPassword({ email: data.user.email, password: currentPassword });
            if (verified.error || verified.data.user?.id !== request.user.sub) {
                return reply.code(403).send({ error: 'Your current password did not match.' });
            }
            // Dispose of the verification session without affecting the user's existing session.
            await verifier.auth.signOut({ scope: 'local' });
            client = await db.connect();
            await client.query('BEGIN');
            await erasePrivateAccount(client, request.user.sub);
            await client.query('COMMIT');
            committed = true;
            clearAccountCaches(request.user.sub);
            await finishAccountDeletion(db, request.user.sub, supabase);
            return reply.header('Cache-Control', 'no-store').send({ deleted: true, cleanupPending: false });
        } catch (error) {
            if (client && !committed) await client.query('ROLLBACK').catch(() => {});
            fastify.log.error('Account closure cleanup failed');
            // The tombstone already denies all sessions. The durable worker finishes remote cleanup.
            if (committed) return reply.code(202).send({ deleted: true, cleanupPending: true });
            return reply.code(503).send({ error: 'Could not close your account. Please try again.' });
        } finally { client?.release(); }
    });
}
