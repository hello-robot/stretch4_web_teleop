/**
 * In-memory operator voice session tokens for local socket.io teleop.
 * Issued on join_as_operator success; required for GET /openai-realtime/token.
 */
const crypto = require("crypto");

/**
 * If user disconnects voice, but reconnects within TTL timeframe then it
 * will reuse the token and will bypass minting a new token.
 *
 */
const VOICE_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** @type {Map<string, { socketId: string, expiresAt: number }>} */
const tokensByValue = new Map();

/**
 * @param {string} socketId
 * @returns {string}
 */
function issueToken(socketId) {
    const token = crypto.randomBytes(32).toString("hex");
    tokensByValue.set(token, {
        socketId,
        expiresAt: Date.now() + VOICE_SESSION_TTL_MS,
    });
    return token;
}

/**
 * @param {string} socketId
 */
function revokeBySocket(socketId) {
    for (const [token, entry] of tokensByValue.entries()) {
        if (entry.socketId === socketId) {
            tokensByValue.delete(token);
        }
    }
}

/**
 * @param {string | undefined} token
 * @param {string | undefined} operSockId
 * @param {import("socket.io").Server | undefined} io
 * @returns {boolean}
 */
function validate(token, operSockId, io) {
    if (!token || !operSockId || !io) {
        return false;
    }
    const entry = tokensByValue.get(token);
    if (!entry) {
        return false;
    }
    if (Date.now() > entry.expiresAt) {
        tokensByValue.delete(token);
        return false;
    }
    if (entry.socketId !== operSockId) {
        return false;
    }
    if (!io.sockets.sockets.get(entry.socketId)) {
        tokensByValue.delete(token);
        return false;
    }
    return true;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True for requests from the robot's own browser (Playwright on the robot,
 * loading https://localhost/robot). It relays minted credentials to the
 * operator over the WebRTC data channel when the operator page is served
 * from Firebase Hosting and cannot reach this server.
 *
 * Tunnels such as ngrok also connect from loopback, but they add forwarding
 * headers; any forwarded request is treated as remote.
 *
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function isLocalRobotRequest(req) {
    const address = req.socket?.remoteAddress;
    if (!address || !LOOPBACK_ADDRESSES.has(address)) {
        return false;
    }
    return !req.get("x-forwarded-for") && !req.get("x-forwarded-host") && !req.get("forwarded");
}

module.exports = {
    VOICE_SESSION_TTL_MS,
    issueToken,
    revokeBySocket,
    validate,
    isLocalRobotRequest,
};
