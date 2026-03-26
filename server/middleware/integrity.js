/**
 * HMAC integrity module for score tamper protection.
 * Signs score records so database modifications are detectable.
 */

import { createHmac } from 'crypto';

function getHmacSecret() {
    if (process.env.SCORE_HMAC_SECRET) return process.env.SCORE_HMAC_SECRET;
    // Derive from admin key as fallback
    if (process.env.ADMIN_PRIVATE_KEY) {
        return createHmac('sha256', 'attentionx-score-key')
            .update(process.env.ADMIN_PRIVATE_KEY)
            .digest('hex');
    }
    throw new Error('No SCORE_HMAC_SECRET or ADMIN_PRIVATE_KEY set');
}

/**
 * HMAC-SHA256 for a player's daily score record.
 */
export function computeScoreHmac(data) {
    const secret = getHmacSecret();
    const payload = JSON.stringify({
        t: data.tournamentId,
        p: data.playerAddress,
        d: data.date,
        pts: data.points,
        b: data.breakdown
    });
    return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * HMAC-SHA256 for a daily startup base score.
 */
export function computeDailyScoreHmac(data) {
    const secret = getHmacSecret();
    const payload = JSON.stringify({
        t: data.tournamentId,
        s: data.startupName,
        d: data.date,
        pts: data.basePoints,
        tw: data.tweetsAnalyzed
    });
    return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * HMAC-SHA256 for a leaderboard entry.
 */
export function computeLeaderboardHmac(data) {
    const secret = getHmacSecret();
    const payload = JSON.stringify({
        t: data.tournamentId,
        p: data.playerAddress,
        s: data.totalScore
    });
    return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify an HMAC with constant-time comparison.
 */
export function verifyHmac(computeFn, data, storedHmac) {
    if (!storedHmac) return null; // No HMAC stored (legacy data)
    const computed = computeFn(data);
    if (computed.length !== storedHmac.length) return false;
    let result = 0;
    for (let i = 0; i < computed.length; i++) {
        result |= computed.charCodeAt(i) ^ storedHmac.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Integrity hash chain — links each day's scores to the previous day.
 * Modifying any historical score breaks the chain.
 */
export function computeIntegrityHash(tournamentId, date, scoresJson, previousHash) {
    const secret = getHmacSecret();
    const payload = `${tournamentId}:${date}:${scoresJson}:${previousHash || 'GENESIS'}`;
    return createHmac('sha256', secret).update(payload).digest('hex');
}
