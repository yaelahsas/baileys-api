import { getSession, formatGroup, formatPhone } from '../whatsapp.js'
import response from './../response.js'

const getMessages = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    const { jid } = req.params
    const { limit = 25, cursor_id = null, cursor_fromMe = null, isGroup } = req.query

    // Auto-detect if JID is a group based on the JID format
    // Group JIDs end with @g.us, individual JIDs end with @s.whatsapp.net
    // If user doesn't specify isGroup, detect it from the JID itself
    const isGroupBool = isGroup === 'true' || jid.endsWith('@g.us')
    const jidFormat = isGroupBool ? formatGroup(jid) : formatPhone(jid)

    const cursor = {}

    if (cursor_id) {
        cursor.before = {
            id: cursor_id,
            fromMe: cursor_fromMe === 'true',
        }
    }

    try {
        const useCursor = 'before' in cursor ? cursor : null

        // Check if store is available
        if (!session?.store) {
            return response(res, 500, false, 'Store not available on this session. Messages may not be loaded.')
        }

        const messages = await session.store.loadMessages(jidFormat, limit, useCursor)

        // Ensure messages is always an array for consistent response format
        const messageArray = Array.isArray(messages) ? messages : messages ? [...messages.values()] : []

        response(res, 200, true, '', {
            jid: jidFormat,
            isGroup: isGroupBool,
            count: messageArray.length,
            messages: messageArray,
        })
    } catch (err) {
        console.error('[ERROR] getMessages failed:', err.message, { jid: jidFormat, isGroup: isGroupBool })
        response(res, 500, false, 'Failed to load messages.', { error: err.message })
    }
}

export default getMessages
