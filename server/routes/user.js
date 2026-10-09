import pool from '../db/mockDB.js';
import {
    AVATAR_ART_VERSION,
    avatarItemColumns,
    parseOutfitRequest,
    serializeAvatarItemV2,
    serializeProfile,
    validateOutfitItems,
} from '../utils/avatarV2.js';
import { bannersFor } from './banners.js';
import {
    RegExpMatcher,
    englishDataset,
    englishRecommendedTransformers,
} from 'obscenity';

const profanityMatcher = new RegExpMatcher({
    ...englishDataset.build(),
    ...englishRecommendedTransformers,
});

function serializeCurrencyTransaction(row) {
    return {
        id: row.id,
        amount: Number(row.amount),
        balanceAfter: Number(row.balance_after),
        transactionType: row.transaction_type,
        sourceType: row.source_type,
        sourceId: row.source_id,
        counterpartyUserId: row.counterparty_user_id,
        metadata: row.metadata,
        createdAt: row.created_at,
    };
}

export async function getWalletPayload(userId, { limit = 25, includeTransactions = true } = {}) {
    await pool.query('SELECT public.ensure_user_wallet($1)', [userId]);

    const walletResult = await pool.query(`
        SELECT coin_balance, created_at, updated_at
        FROM user_wallets
        WHERE user_id = $1
    `, [userId]);

    const transactionRows = includeTransactions
        ? (await pool.query(`
            SELECT id, amount, balance_after, transaction_type, source_type, source_id,
                counterparty_user_id, metadata, created_at
            FROM currency_transactions
            WHERE user_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
        `, [userId, limit])).rows
        : [];

    return {
        coinBalance: Number(walletResult.rows[0]?.coin_balance || 0),
        createdAt: walletResult.rows[0]?.created_at,
        updatedAt: walletResult.rows[0]?.updated_at,
        transactions: transactionRows.map(serializeCurrencyTransaction),
    };
}

async function getAvatarPayload(userId, client = pool) {
    await client.query('SELECT public.seed_user_avatar_defaults($1)', [userId]);

    const profileResult = await client.query(`
        SELECT build_chosen, skin, hair, eyes, updated_at
        FROM user_avatar_profile
        WHERE user_id = $1
    `, [userId]);

    const outfitResult = await client.query(`
        SELECT uoi.item_instance_id, uoi.dyes AS chosen_dyes, ${avatarItemColumns}
        FROM user_outfit_items uoi
        JOIN avatar_items ai ON ai.id = uoi.item_id
        WHERE uoi.user_id = $1
        ORDER BY ai.category ASC, ai.stack_order ASC, uoi.item_instance_id ASC
    `, [userId]);

    const inventoryResult = await client.query(`
        SELECT uii.id AS item_instance_id, ${avatarItemColumns}
        FROM user_item_instances uii
        JOIN avatar_items ai ON ai.id = uii.item_id
        WHERE uii.user_id = $1
          AND uii.status = 'owned'
          AND ai.art_version = ${AVATAR_ART_VERSION}
        ORDER BY ai.category ASC, ai.name ASC, uii.id ASC
    `, [userId]);

    return {
        profile: serializeProfile(profileResult.rows[0]),
        outfit: outfitResult.rows.map((row) => ({
            itemInstanceId: Number(row.item_instance_id),
            dyes: row.chosen_dyes || {},
            item: serializeAvatarItemV2(row),
        })),
        inventory: inventoryResult.rows.map((row) => ({
            itemInstanceId: Number(row.item_instance_id),
            item: serializeAvatarItemV2(row),
        })),
    };
}

export default async function (fastify, options) {

    fastify.get('/', async (request, reply) => {
        const userId = request.user.sub;
        try {
            const result = await pool.query(
                'SELECT * FROM users WHERE id = $1',
                [userId]
            );
            return { data: result.rows[0] };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'An error occurred while fetching the username' });
        }
    });

    fastify.get('/avatar', async (request, reply) => {
        const userId = request.user.sub;
        try {
            return { data: await getAvatarPayload(userId) };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'An error occurred while fetching the avatar' });
        }
    });

    // Other players' looks, to draw them (e.g. animated on the scoreboard): what they wear
    // and their colouring, nothing of what they own. ?ids= a comma list of user ids.
    fastify.get('/looks', async (request, reply) => {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const ids = [...new Set(String(request.query?.ids || '').split(',').map((id) => id.trim()).filter((id) => uuid.test(id)))].slice(0, 60);
        if (ids.length === 0) return { data: {} };
        try {
            const [profiles, outfits, banners] = await Promise.all([
                pool.query(`
                    SELECT user_id, build_chosen, skin, hair, eyes, updated_at
                    FROM user_avatar_profile
                    WHERE user_id = ANY($1::uuid[])
                `, [ids]),
                pool.query(`
                    SELECT uoi.user_id, uoi.dyes AS chosen_dyes, ${avatarItemColumns}
                    FROM user_outfit_items uoi
                    JOIN avatar_items ai ON ai.id = uoi.item_id
                    WHERE uoi.user_id = ANY($1::uuid[])
                    ORDER BY ai.category ASC, ai.stack_order ASC, uoi.item_instance_id ASC
                `, [ids]),
                bannersFor(ids),
            ]);
            const looks = {};
            profiles.rows.forEach((row) => {
                const { skin, hair, eyes } = serializeProfile(row);
                looks[row.user_id] = { profile: { skin, hair, eyes }, outfit: [] };
            });
            outfits.rows.forEach((row) => {
                looks[row.user_id]?.outfit.push({ dyes: row.chosen_dyes || {}, item: serializeAvatarItemV2(row) });
            });
            // (and the banner each has up on the scoreboard)
            Object.entries(banners).forEach(([userId, banner]) => {
                if (looks[userId]) looks[userId].banner = banner;
            });
            return { data: looks };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'An error occurred while fetching looks' });
        }
    });

    fastify.get('/wallet', async (request, reply) => {
        const userId = request.user.sub;
        const limit = Math.min(Math.max(parseInt(request.query?.limit || '25', 10), 1), 100);

        try {
            return {
                data: await getWalletPayload(userId, { limit }),
            };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'An error occurred while fetching the wallet' });
        }
    });

    fastify.put('/avatar/save', async (request, reply) => {
        const userId = request.user.sub;
        const parsed = parseOutfitRequest(request.body);
        if (parsed.error) {
            return reply.code(400).send({ error: parsed.error });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const instanceIds = parsed.entries.map((entry) => entry.itemInstanceId);
            // Lock the copies so they can't be listed for sale mid-save.
            const ownedResult = instanceIds.length > 0
                ? await client.query(`
                    SELECT uii.id AS item_instance_id, ${avatarItemColumns}
                    FROM user_item_instances uii
                    JOIN avatar_items ai ON ai.id = uii.item_id
                    WHERE uii.user_id = $1
                      AND uii.id = ANY($2::bigint[])
                      AND uii.status = 'owned'
                      AND ai.art_version = ${AVATAR_ART_VERSION}
                    FOR UPDATE OF uii
                `, [userId, instanceIds])
                : { rows: [] };

            const ownedById = new Map(ownedResult.rows.map((row) => [Number(row.item_instance_id), row]));
            const outfitError = validateOutfitItems(parsed.entries, ownedById);
            if (outfitError) {
                await client.query('ROLLBACK');
                return reply.code(400).send({ error: outfitError });
            }

            await client.query('DELETE FROM user_outfit_items WHERE user_id = $1', [userId]);
            for (const entry of parsed.entries) {
                await client.query(`
                    INSERT INTO user_outfit_items (user_id, item_instance_id, item_id, dyes)
                    VALUES ($1, $2, $3, $4::jsonb)
                `, [userId, entry.itemInstanceId, ownedById.get(entry.itemInstanceId).id, JSON.stringify(entry.dyes)]);
            }

            await client.query(`
                INSERT INTO user_avatar_profile (user_id, build_chosen, skin, hair, eyes, updated_at)
                VALUES ($1, TRUE, $2, $3, $4, now())
                ON CONFLICT (user_id) DO UPDATE SET
                    build_chosen = TRUE,
                    skin = EXCLUDED.skin,
                    hair = EXCLUDED.hair,
                    eyes = EXCLUDED.eyes,
                    updated_at = now()
            `, [userId, parsed.profile.skin, parsed.profile.hair, parsed.profile.eyes]);

            const payload = await getAvatarPayload(userId, client);
            await client.query('COMMIT');
            return { data: payload };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            fastify.log.error(error);
            return reply.code(500).send({ error: 'An error occurred while saving the avatar' });
        } finally {
            client.release();
        }
    });

    fastify.put('/updateUsername', async (request, reply) => {
        const userId = request.user.sub;
        const { newUsername } = request.body;

        if (profanityMatcher.hasMatch(newUsername)) {
            return reply.code(400).send({ error: 'Username contains inappropriate language' });
        }

        if (!userId || !newUsername) {
            return reply.code(400).send({ error: 'User ID and new username are required' });
        }

        // Add username validation
        if (!/^[a-zA-Z0-9_]{1,32}$/.test(newUsername)) {
            return reply.code(400).send({ error: 'Username must be 1-32 characters long and contain only letters, numbers, and underscores' });
        }

        try {
            const result = await pool.query(
                'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username',
                [newUsername, userId]
            );

            if (result.rowCount === 0) {
                return reply.code(404).send({ error: 'User not found' });
            }

            return { data: result.rows[0] };
        } catch (error) {
            fastify.log.error(error);
            if (error.code === '23505') {
                return reply.code(409).send({ error: 'Username is already taken' });
            }
            return reply.code(500).send({ error: 'An error occurred while updating the username' });
        }
    });
}
