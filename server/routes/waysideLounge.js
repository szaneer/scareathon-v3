import { createContentGate, onContentRemoved } from '../utils/contentSafety.js';
import { onAccountClosed } from '../utils/accountSessions.js';
import websocket from '@fastify/websocket';
import pool from '../db/mockDB.js';
import { isAdminUser } from './inbox.js';
import { LoungeError, createLounge } from '../waysideOnline/lounge.js';
import { listHosting, subscribeHosting } from '../wayside-fury/presence.js';
import {
    RegExpMatcher,
    TextCensor,
    englishDataset,
    englishRecommendedTransformers,
} from 'obscenity';

const HEARTBEAT_MS = 30_000;
// How many members who aren't in stand about the room so it's never empty
export const CROWD_SIZE = 40;

const ERROR_MESSAGES = {
    ticket: 'Your way in expired. Try again.',
    full: 'The lounge is full right now. Try again in a minute.',
    kicked: "You've been shown out of the lounge for a little while.",
    slow: 'Slow down a little.',
    forbidden: "That's for admins.",
};

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const censor = new TextCensor();
const mask = (line) => censor.applyTo(line, matcher.getAllMatches(line));

// The Wayside Online lounge: GET /ws (open to guests, who watch), POST /ticket (a
// login's one-use way in), GET /crowd (members who've made an avatar, to fill the room).
export default async function waysideLoungeRoutes(fastify, { lounge: injectedLounge } = {}) {
    const log = fastify.log.child({ feature: 'wayside-lounge' });
    const lounge = injectedLounge ?? createLounge({ mask, hosting: listHosting });
    const stopHosting = subscribeHosting(() => lounge.hostingChanged());

    if (!fastify.hasDecorator('websocketServer')) {
        await fastify.register(websocket, { options: { maxPayload: 8192 } });
    }

    const stopClosures = onAccountClosed(userId => {
        lounge.forgetUser?.(userId);
    });
    const stopModeration = onContentRemoved(({ type, id, userId }) => {
        if (type === 'lounge_chat') lounge.removeReport?.(id);
        if (userId) lounge.forgetUser?.(userId);
    });
    const gate = createContentGate(pool);
    const sockets = new Set();
    const heartbeat = setInterval(() => {
        for (const socket of sockets) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            socket.ping();
        }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    fastify.addHook('onClose', async () => {
        stopClosures();
        stopModeration();
        clearInterval(heartbeat);
        stopHosting();
        lounge.close();
    });

    fastify.post('/ticket', async (request, reply) => {
        try {
            const result = await pool.query("SELECT CASE WHEN deleted_at IS NOT NULL THEN 'Deleted rider' ELSE username END AS username FROM users WHERE id = $1", [request.user.sub]);
            const ticket = lounge.ticket({
                userId: request.user.sub,
                name: result.rows[0]?.username || 'Someone',
                admin: isAdminUser(request.user),
            });
            return { ticket };
        } catch (error) {
            if (error instanceof LoungeError) return reply.code(403).send({ error: ERROR_MESSAGES[error.code] });
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Could not open the lounge door' });
        }
    });

    fastify.get('/crowd', async (_request, reply) => {
        try {
            const result = await pool.query(`
                SELECT p.user_id, u.username
                FROM user_avatar_profile p
                JOIN users u ON u.id = p.user_id
                WHERE p.build_chosen
                ORDER BY p.updated_at DESC
                LIMIT $1
            `, [CROWD_SIZE]);
            const hosts = listHosting();
            const hostIds = new Set(hosts.map((member) => member.userId));
            const crowd = result.rows.filter((row) => !hostIds.has(row.user_id)).map((row) => ({
                userId: row.user_id, name: row.username || 'Someone', hosting: null,
            }));
            return { data: [...hosts, ...crowd].slice(0, CROWD_SIZE) };
        } catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Could not see who is about' });
        }
    });

    fastify.get('/ws', { websocket: true }, (socket) => {
        sockets.add(socket);
        socket.isAlive = true;
        socket.on('pong', () => {
            socket.isAlive = true;
        });
        socket.on('error', (error) => log.warn({ err: error }, 'Lounge socket error'));
        socket.on('close', () => {
            sockets.delete(socket);
            lounge.disconnect(socket);
        });
        lounge.watch(socket);
        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                return;
            }
            try {
                switch (message?.type) {
                    case 'join':
                        lounge.join(socket, message);
                        break;
                    case 'move':
                        lounge.move(socket, message);
                        break;
                    case 'say': {
                        let denied = false;
                        await gate({ method: 'POST', url: '/wayside-online/lounge/ticket', user: { sub: lounge.userFor?.(socket) } }, {
                            code() { return this; },
                            send(error) { denied = true; socket.send(JSON.stringify({ type: 'error', code: error.code, message: error.error })); },
                        });
                        if (!denied) lounge.say(socket, message);
                        break;
                    }
                    case 'kick':
                        lounge.kick(socket, message);
                        break;
                    case 'leave':
                        lounge.leave(socket);
                        break;
                    default:
                        break;
                }
            } catch (error) {
                if (error instanceof LoungeError) {
                    socket.send(JSON.stringify({ type: 'error', code: error.code, message: ERROR_MESSAGES[error.code] ?? 'Something went wrong.' }));
                } else {
                    log.error({ err: error }, 'Lounge message failed');
                }
            }
        });
    });
}
