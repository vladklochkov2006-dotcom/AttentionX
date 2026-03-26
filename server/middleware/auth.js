/**
 * Authentication & validation middleware for AttentionX API.
 * - Admin API key authentication
 * - Input validators
 */

/**
 * Middleware: checks X-Admin-Key header against ADMIN_API_KEY env var.
 */
export function requireAdmin(req, res, next) {
    const adminKey = process.env.ADMIN_API_KEY;

    if (!adminKey) {
        return res.status(503).json({
            success: false,
            error: 'Admin authentication not configured'
        });
    }

    const providedKey = req.headers['x-admin-key'];
    if (!providedKey || providedKey !== adminKey) {
        return res.status(403).json({
            success: false,
            error: 'Invalid or missing admin key'
        });
    }

    next();
}

// ============ Validators ============

export function isValidAddress(address) {
    return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function isValidTournamentId(id) {
    const n = parseInt(id, 10);
    return Number.isInteger(n) && n > 0;
}

export function isValidDate(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date));
}

export function isValidUsername(username) {
    return typeof username === 'string'
        && username.length >= 3
        && username.length <= 20
        && /^[a-zA-Z0-9_\-. ]+$/.test(username);
}
