import { getSession, formatGroup, formatPhone } from '../whatsapp.js'
import response from './../response.js'

const getMessages = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    const { jid } = req.params
    const { limit = 25, cursor_id = null, cursor_fromMe = null, isGroup, from, to } = req.query

    // Auto-detect if JID is a group based on the JID format
    // Group JIDs end with @g.us, individual JIDs end with @s.whatsapp.net
    // If user doesn't specify isGroup, detect it from the JID itself
    const isGroupBool = isGroup === 'true' || jid.endsWith('@g.us')
    const jidFormat = isGroupBool ? formatGroup(jid) : formatPhone(jid)

    const limitNum = Math.max(1, Math.min(500, parseInt(limit) || 25))

    const cursor = {}

    if (cursor_id) {
        cursor.before = {
            id: cursor_id,
            fromMe: cursor_fromMe === 'true',
        }
    }

    // Optional date-range filter (unix seconds). Lets the log view request only the
    // messages it needs (e.g. a month) instead of scanning the full chat history.
    const dateOptions = {}
    const parsedFrom = parseTimestampParam(from)
    const parsedTo = parseTimestampParam(to)
    if (parsedFrom !== null) dateOptions.from = parsedFrom
    if (parsedTo !== null) dateOptions.to = parsedTo

    try {
        const useCursor = 'before' in cursor ? cursor : null

        // Check if store is available
        if (!session?.store) {
            return response(res, 500, false, 'Store not available on this session. Messages may not be loaded.')
        }

        const messages = await session.store.loadMessages(jidFormat, limitNum, useCursor, dateOptions)

        // Ensure messages is always an array for consistent response format
        const messageArray = Array.isArray(messages) ? messages : messages ? [...messages.values()] : []

        response(res, 200, true, '', {
            jid: jidFormat,
            isGroup: isGroupBool,
            count: messageArray.length,
            messages: messageArray,
            range: { from: parsedFrom, to: parsedTo },
        })
    } catch (err) {
        console.error('[ERROR] getMessages failed:', err.message, { jid: jidFormat, isGroup: isGroupBool })
        response(res, 500, false, 'Failed to load messages.', { error: err.message })
    }
}

/**
 * Parse a `from`/`to` query param which may be either a unix-seconds number or an
 * ISO date string (YYYY-MM-DD). Returns unix seconds or null if invalid.
 *
 * @param {string|number|undefined} value - The raw query value
 * @returns {number|null} Unix seconds, or null when absent/invalid
 */
const parseTimestampParam = (value) => {
    if (value === undefined || value === null || value === '') return null

    // Numeric (unix seconds or milliseconds)
    const numeric = Number(value)
    if (!Number.isNaN(numeric) && value !== '') {
        // Normalize ms (13 digits) to seconds (10 digits) if prefixed with ms range
        return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric
    }

    // ISO date (YYYY-MM-DD or full datetime)
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
        return Math.floor(parsed / 1000)
    }

    return null
}

export default getMessages
