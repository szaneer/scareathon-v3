import dotenv from 'dotenv';
dotenv.config();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isOptionalAuthRoute, isPublicRoute } from './utils/authRoutes.js';
import calendarRoutes from './routes/calendar.js';
import postsRoutes, { getPostsPayload, getRecentPostsPayload } from './routes/posts.js';
import leaderboardRoutes from './routes/leaderboard.js';
import scareathonRoutes from './routes/scareathon.js';
import agentTokenRoutes from './routes/agentTokens.js';
import { authenticateAgent, isAgentToken } from './utils/agentTokens.js';
import { ensureScareathonTables, runStartupSql } from './utils/scareathon.js';
import { SCAREATHON_GIFT_SQL } from './utils/scareathonGift.js';
import { readFile } from 'node:fs/promises';
import waysideRoutes, { ensureDailyRuneIndex } from './routes/wayside.js';
import weeklyChallengeRoutes from './routes/weeklyChallenges.js';
import eightbitevilreturnsRoutes from './routes/8bitevilreturns.js';
import eightBitEvilV2Routes from './routes/8bitevilreturnsV2.js';
import octoberValleyRoutes from './routes/octoberValley.js';
import gamesRoutes from './routes/games.js';
import dailyPuzzleRoutes from './routes/dailyPuzzles.js';
import userRoutes from './routes/user.js';
import accountPrivacyRoutes from './routes/accountPrivacy.js';
import { listenForAccountClosures } from './utils/accountSessions.js';
import { retryAccountDeletions } from './utils/accountPrivacy.js';
import marketplaceRoutes from './routes/marketplace.js';
import inboxRoutes from './routes/inbox.js';
import adminStrapiRoutes from './routes/adminStrapi.js';
import homeRoutes from './routes/home.js';
import capsuleRoutes from './routes/capsule.js';
import casinoRoutes, { isCasinoEnabled } from './routes/casino.js';
import monsterBashRoutes, { isMonsterBashEnabled } from './routes/monsterBash.js';
import cryptClashRoutes, { isCryptClashEnabled } from './routes/cryptClash.js';
import frogBallRoutes, { isFrogBallEnabled } from './routes/frogBall.js';
import mysteryCryptRoutes from './routes/mysteryCrypt.js';
import waysideFuryRoutes from './routes/waysideFury.js';
import waysideFuryCoopRoutes from './routes/waysideFuryCoop.js';
import scareCapitalistRoutes from './routes/scareCapitalist.js';
import pictoBoxRoutes from './routes/pictoBox.js';
import waysideOnlineRoutes, { WAYSIDE_ONLINE_SQL } from './routes/waysideOnline.js';
import waysideLoungeRoutes from './routes/waysideLounge.js';
import bannersRoutes, { BACKGROUND_BANNERS_SQL, BANNERS_SQL } from './routes/banners.js';
import songsRoutes, { SONGS_SQL } from './routes/songs.js';
import cartsRoutes, { CARTS_SQL } from './routes/carts.js';
import websocket from '@fastify/websocket';
import pool from './db/mockDB.js';
import complianceRoutes from './routes/compliance.js';
import { createGeoHook, startGeoDatabase } from './utils/geo.js';
import { createContentGate } from './utils/contentSafety.js';
import { registerComplianceRateLimits } from './utils/complianceRateLimits.js';

const fastify = Fastify({
    logger: true,
    trustProxy: 1 // Railway appends the client address; trust only the immediate proxy
});

// Leave a trail when the process goes down, so restarts (which end any live
// Monster Bash bout early) can be traced to a cause.
const bootedAt = Date.now();
function memoryUsageMb() {
    const usage = process.memoryUsage();
    const mb = (bytes) => Math.round(bytes / 1024 / 1024);
    return { rss: mb(usage.rss), heapUsed: mb(usage.heapUsed), heapTotal: mb(usage.heapTotal), external: mb(usage.external) };
}
fastify.log.info({ pid: process.pid, node: process.version, memoryMb: memoryUsageMb() }, 'Server process starting');
process.on('uncaughtException', (err, origin) => {
    fastify.log.fatal({ err, origin, uptimeSec: Math.round((Date.now() - bootedAt) / 1000), memoryMb: memoryUsageMb() }, 'Uncaught exception; exiting');
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    fastify.log.error({ err: reason, memoryMb: memoryUsageMb() }, 'Unhandled promise rejection');
});
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        fastify.log.warn({ signal, uptimeSec: Math.round((Date.now() - bootedAt) / 1000), memoryMb: memoryUsageMb() }, 'Received shutdown signal');
        fastify.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 5_000).unref();
    });
}
process.on('exit', (code) => {
    fastify.log.warn({ code, uptimeSec: Math.round((Date.now() - bootedAt) / 1000) }, 'Server process exiting');
});
// A steady memory reading makes an out-of-memory kill (which leaves no log of
// its own) visible as a climb right before the restart.
setInterval(() => {
    fastify.log.info({ memoryMb: memoryUsageMb(), uptimeSec: Math.round((Date.now() - bootedAt) / 1000) }, 'Server heartbeat');
}, 5 * 60_000).unref();

function getAuthConfig() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const projectRef = process.env.SUPABASE_PROJECT_REF;
    const explicitJwks = process.env.SUPABASE_JWKS_URL;

    if (explicitJwks) {
        return {
            issuer: process.env.SUPABASE_JWT_ISSUER || null,
            jwksUrl: explicitJwks
        };
    }

    if (supabaseUrl) {
        const base = supabaseUrl.replace(/\/$/, '');
        return {
            issuer: `${base}/auth/v1`,
            jwksUrl: `${base}/auth/v1/.well-known/jwks.json`
        };
    }

    if (projectRef) {
        const base = `https://${projectRef}.supabase.co`;
        return {
            issuer: `${base}/auth/v1`,
            jwksUrl: `${base}/auth/v1/.well-known/jwks.json`
        };
    }

    throw new Error('Missing SUPABASE_URL or SUPABASE_PROJECT_REF (or SUPABASE_JWKS_URL) for JWT verification.');
}

function getBearerToken(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
    return parts[1];
}

function isTransientJwtVerificationError(error) {
    return (
        error?.code === 'ERR_JWKS_TIMEOUT' ||
        error?.code === 'ERR_JWKS_FETCH_FAILED' ||
        error?.name === 'JWKSTimeout'
    );
}

async function main() {
    try {
        const authConfig = getAuthConfig();
        const jwks = createRemoteJWKSet(new URL(authConfig.jwksUrl));

        await ensureScareathonTables(pool);
        // Account tombstones must exist before accepting requests (fail closed on migration errors).
        await runStartupSql(pool, await readFile(new URL('./db/migrations/20261013_account_privacy.sql', import.meta.url), 'utf8'));
        await runStartupSql(pool, await readFile(new URL('./db/migrations/20261014_compliance.sql', import.meta.url), 'utf8'));
        await runStartupSql(pool, await readFile(new URL('./db/migrations/20261015_terms_acceptance.sql', import.meta.url), 'utf8'));
        const stopClosureListener = await listenForAccountClosures(pool, fastify.log);
        fastify.addHook('onClose', stopClosureListener);
        const cleanup = () => retryAccountDeletions(pool, fastify.log).catch(() => fastify.log.error('Account cleanup unavailable'));
        void cleanup();
        const cleanupTimer = setInterval(cleanup, 60_000);
        cleanupTimer.unref();
        fastify.addHook('onClose', async () => clearInterval(cleanupTimer));

        // The Scareboard's tables and the rune tablet's index, made if missing. In the
        // background: a slow one (waiting on a lock while the old server's still up) must
        // never keep this one from starting
        void (async () => {
            try {
                await ensureScareathonTables(pool);
                await ensureDailyRuneIndex(pool);
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261002_rename_body_kid.sql', import.meta.url), 'utf8'));
                await runStartupSql(pool, WAYSIDE_ONLINE_SQL); // Wayside Online's posts and reactions
                await runStartupSql(pool, BANNERS_SQL); // scoreboard banners
                await runStartupSql(pool, SONGS_SQL); // songs for the bench's radio
                await runStartupSql(pool, CARTS_SQL); // cartridges sold at the counter
                await runStartupSql(pool, BACKGROUND_BANNERS_SQL); // background items become banners
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261003_halloween_items.sql', import.meta.url), 'utf8')); // eight new shop items
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261006_shop_round_two.sql', import.meta.url), 'utf8')); // the shop's second round
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261006_shop_round_three.sql', import.meta.url), 'utf8')); // its third, and held things move out to the hand
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_jack_o_lantern_mask.sql', import.meta.url), 'utf8')); // the jack-o'-lantern head is a mask
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_shop_round_four.sql', import.meta.url), 'utf8')); // the shop's fourth round
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_shop_round_five.sql', import.meta.url), 'utf8')); // its fifth
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_shop_mini_me.sql', import.meta.url), 'utf8')); // the Mini Me companion
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_shop_shirts.sql', import.meta.url), 'utf8')); // ten more shirts
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_shop_game_sprites.sql', import.meta.url), 'utf8')); // items from the games' sprites
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261007_trophy_legendary.sql', import.meta.url), 'utf8')); // the Trophy: legendary, 1000 tickets
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261008_shop_two_of_everything.sql', import.meta.url), 'utf8')); // two more of everything
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261008_shop_imp.sql', import.meta.url), 'utf8')); // the Imp pet
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261008_long_locks_crown.sql', import.meta.url), 'utf8')); // Long Locks: the head no longer shows through
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261009_more_animated_items.sql', import.meta.url), 'utf8')); // more hair, wings and the rest move
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261009_back_items_behind.sql', import.meta.url), 'utf8')); // things on your back go behind you
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261009_ponytail_behind.sql', import.meta.url), 'utf8')); // and so does the ponytail
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261008_add_casino_rounds.sql', import.meta.url), 'utf8')); // the casino's house games
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261010_capsule_items.sql', import.meta.url), 'utf8')); // fifty hats and held things for the capsule machine
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261010_capsule_machine.sql', import.meta.url), 'utf8')); // and the machine itself
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261011_capsule_commons.sql', import.meta.url), 'utf8')); // ten more commons for it
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261011_shop_commons.sql', import.meta.url), 'utf8')); // five more commons in every other category
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261011_pets_cost_more.sql', import.meta.url), 'utf8')); // pets cost twice as much
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261012_add_wayside_fury_game.sql', import.meta.url), 'utf8')); // Wayside Fury's arcade scores
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261012_add_wayside_fury_saves.sql', import.meta.url), 'utf8')); // revisioned Wayside Fury character sheets
                await runStartupSql(pool, await readFile(new URL('./db/migrations/20261008_agent_tokens.sql', import.meta.url), 'utf8')); // agent keys for the wayside CLI
            } catch (err) {
                // The rest of the site still works; only the Scareboard and the runes need these
                fastify.log.error({ err }, 'Could not create the Scareathon tables');
            }
            // A gift in every player's inbox, for the Scareathon (those who have theirs are passed
            // over). On its own: nothing above waits on it, and it doesn't wait on what failed above
            try {
                await runStartupSql(pool, SCAREATHON_GIFT_SQL);
            } catch (err) {
                fastify.log.error({ err }, 'Could not send the Scareathon gifts');
            }
        })();

        await fastify.register(cors, {
            origin: [
                'http://localhost:5173',
                'http://127.0.0.1:5173',
                'https://www.scareathon.rip',
                'https://scareathon.rip',
                'https://www.waysidestation.com',
                'https://waysidestation.com',
                'https://scareathon-v3.vercel.app',
                'https://scarbone98.github.io',
                'https://sclondon.github.io',
                // 31 Nights (perhapsJohn's GitHub Pages) looks up the arcade player's name
                'https://perhapsjohn.github.io'
            ],
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            credentials: true
        });
        fastify.decorateRequest('user', null);
        const geo = await startGeoDatabase(fastify.log);
        fastify.addHook('onRequest', createGeoHook({ lookup: geo.lookup, ready: geo.ready }));
        fastify.addHook('onClose', async () => geo.close());
        await registerComplianceRateLimits(fastify);
        // Registered once for every socket route: each registration adds its own
        // raw 'upgrade' listener, so two would handle every connection twice.
        await fastify.register(websocket, { options: { maxPayload: 65_536 } });

        fastify.addHook('preValidation', async (request, reply) => {
            const token = getBearerToken(request.headers.authorization);

            // Agent keys (the wayside CLI) only ever reach the few routes they're allowed,
            // public ones included, and never as an admin (utils/agentTokens.js)
            if (isAgentToken(token)) {
                await authenticateAgent(pool, request, reply, token);
                return;
            }

            if (isPublicRoute(request.method, request.url)) {
                return;
            }

            if (!token) {
                // Guests can read leaderboards; everything else (including score writes) needs a login
                if (isOptionalAuthRoute(request.method, request.url)) {
                    return;
                }
                return reply.code(401).send({ error: 'Unauthorized: missing bearer token' });
            }

            const verifyOptions = {
                audience: 'authenticated'
            };
            if (authConfig.issuer) {
                verifyOptions.issuer = authConfig.issuer;
            }

            let payload;
            try {
                ({ payload } = await jwtVerify(token, jwks, verifyOptions));
            } catch (err) {
                request.log.warn({ err }, 'Supabase JWT verification failed');
                if (isTransientJwtVerificationError(err)) {
                    return reply.code(503).send({ error: 'Authentication service unavailable' });
                }

                return reply.code(401).send({ error: 'Unauthorized' });
            }

            request.user = payload;

            try {
                const userResult = await pool.query(
                    'SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL',
                    [payload.sub]
                );
                if (userResult.rowCount === 0) {
                    return reply.code(401).send({ error: 'Unauthorized: user no longer exists' });
                }
            } catch (err) {
                request.log.error({ err }, 'Database unavailable during auth user check');
                return reply.code(503).send({ error: 'Database unavailable' });
            }
        });

        fastify.addHook('preHandler', createContentGate(pool));

        // Register route handlers
        fastify.register(complianceRoutes, { geoReady: geo.ready });
        fastify.get('/health', async () => ({ ok: true }));
        fastify.register(calendarRoutes);
        fastify.register(postsRoutes);
        fastify.register(weeklyChallengeRoutes, { getPostsPayload, getRecentPostsPayload });
        fastify.register(leaderboardRoutes);
        fastify.register(scareathonRoutes, { prefix: '/scareathon' });
        fastify.register(agentTokenRoutes);
        fastify.register(waysideRoutes, { prefix: '/wayside' });
        fastify.register(gamesRoutes, { prefix: '/games' });
        fastify.register(eightbitevilreturnsRoutes, { prefix: '/8bitevilreturns' });
        fastify.register(eightBitEvilV2Routes, { prefix: '/8bitevilreturns/v2' });
        fastify.register(octoberValleyRoutes, { prefix: '/october-valley' });
        fastify.register(userRoutes, { prefix: '/user' });
        fastify.register(accountPrivacyRoutes, { prefix: '/user' });
        fastify.register(marketplaceRoutes, { prefix: '/marketplace' });
        fastify.register(inboxRoutes, { prefix: '/inbox' });
        fastify.register(adminStrapiRoutes, { prefix: '/admin/strapi' });
        fastify.register(homeRoutes, { prefix: '/home' });
        fastify.register(mysteryCryptRoutes, { prefix: '/mystery-crypt' });
        fastify.register(waysideFuryRoutes, { prefix: '/wayside-fury' });
        fastify.register(waysideFuryCoopRoutes, { prefix: '/wayside-fury/coop' });
        fastify.register(scareCapitalistRoutes, { prefix: '/scare-capitalist' });
        fastify.register(dailyPuzzleRoutes, { prefix: '/daily-puzzles' });
        fastify.register(pictoBoxRoutes, { prefix: '/picto-box' });
        fastify.register(waysideOnlineRoutes, { prefix: '/wayside-online' });
        fastify.register(waysideLoungeRoutes, { prefix: '/wayside-online/lounge' });
        fastify.register(bannersRoutes, { prefix: '/banners' });
        fastify.register(songsRoutes, { prefix: '/songs' });
        fastify.register(cartsRoutes, { prefix: '/carts' });
        fastify.register(capsuleRoutes, { prefix: '/capsule' });
        if (isCasinoEnabled()) {
            fastify.register(casinoRoutes, { prefix: '/casino' });
        }
        if (isMonsterBashEnabled()) {
            fastify.register(monsterBashRoutes, { prefix: '/monster-bash' });
        }
        if (isCryptClashEnabled()) {
            fastify.register(cryptClashRoutes, { prefix: '/crypt-clash' });
        }
        if (isFrogBallEnabled()) {
            fastify.register(frogBallRoutes, { prefix: '/frog-ball' });
        }

        // Run the server!
        const start = async () => {
            try {
                await fastify.listen({ port: 3000, host: '0.0.0.0' });
            } catch (err) {
                fastify.log.error(err);
                process.exit(1);
            }
        }

        start();
    } catch (err) {
        console.error(err);
    }
}

main().catch(console.error);
