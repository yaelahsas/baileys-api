/**
 * Session Manager Module
 * 
 * This module handles all session-related operations including:
 * - Creating new WhatsApp sessions
 * - Managing session lifecycle
 * - Session validation and status checking
 * - Session cleanup and deletion
 */

import { rmSync, readdir } from 'fs'
import { join } from 'path'
import pino from 'pino'
import makeWASocketModule, {
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from 'baileys'
import makeInMemoryStore from '../../store/memory-store.js'
import { toDataURL } from 'qrcode'
import __dirname from '../../dirname.js'
import response from '../../response.js'
import NodeCache from 'node-cache'
import {
    info,
    success,
    error,
    warning,
    debug,
    event,
} from '../utils/logger.js'

/**
 * Session storage maps
 * @type {Map<string, any>}
 */
const sessions = new Map()
const retries = new Map()

/**
 * Message retry counter cache
 * @type {NodeCache}
 */
const msgRetryCounterCache = new NodeCache()

/**
 * Get the sessions directory path
 * 
 * @param {string} sessionId - Optional session ID to append to path
 * @returns {string} Full path to sessions directory
 */
const sessionsDir = (sessionId = '') => {
    return join(__dirname, 'sessions', sessionId ? sessionId : '')
}

/**
 * Check if a session exists in memory
 * 
 * @param {string} sessionId - The session ID to check
 * @returns {boolean} True if session exists, false otherwise
 */
const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

/**
 * Check if a session is connected
 * 
 * @param {string} sessionId - The session ID to check
 * @returns {boolean} True if session is connected, false otherwise
 */
const isSessionConnected = (sessionId) => {
    return sessions.get(sessionId)?.ws?.socket?.readyState === 1
}

/**
 * Determine if a session should reconnect based on retry configuration
 * 
 * @param {string} sessionId - The session ID to check
 * @returns {boolean} True if should reconnect, false otherwise
 */
const shouldReconnect = (sessionId) => {
    const maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let attempts = retries.get(sessionId) ?? 0

    // MaxRetries = maxRetries < 1 ? 1 : maxRetries
    if (attempts < maxRetries || maxRetries === -1) {
        ++attempts

        warning('SessionManager', 'Reconnecting session', {
            sessionId,
            attempts,
            maxRetries,
        })
        retries.set(sessionId, attempts)

        return true
    }

    error('SessionManager', 'Max retries reached, will not reconnect', {
        sessionId,
        attempts,
        maxRetries,
    })

    return false
}

/**
 * Get a session by ID
 * 
 * @param {string} sessionId - The session ID to retrieve
 * @returns {import('baileys').AnyWASocket|null} The session socket or null if not found
 */
const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

/**
 * Get list of all active session IDs
 * 
 * @returns {string[]} Array of session IDs
 */
const getListSessions = () => {
    return [...sessions.keys()]
}

/**
 * Delete a session and clean up all associated files
 * 
 * @param {string} sessionId - The session ID to delete
 */
const deleteSession = (sessionId) => {
    info('SessionManager', 'Deleting session', {
        sessionId,
    })

    const sessionFile = 'md_' + sessionId
    const storeFile = `${sessionId}_store.json`
    const rmOptions = { force: true, recursive: true }

    try {
        rmSync(sessionsDir(sessionFile), rmOptions)
        rmSync(sessionsDir(storeFile), rmOptions)

        sessions.delete(sessionId)
        retries.delete(sessionId)

        success('SessionManager', 'Session deleted successfully', {
            sessionId,
        })
    } catch (err) {
        error('SessionManager', 'Failed to delete session', {
            sessionId,
            error: err.message,
        })
    }
}

/**
 * Create a new WhatsApp session
 * 
 * @param {string} sessionId - Unique identifier for the session
 * @param {object} res - Express response object (optional)
 * @param {object} options - Session creation options
 * @param {boolean} options.usePairingCode - Whether to use pairing code instead of QR
 * @param {string} options.phoneNumber - Phone number for pairing code
 * @param {Function} onMessageUpsert - Callback for message upsert events
 * @param {Function} onConnectionUpdate - Callback for connection update events
 * @param {Function} onWebhook - Callback for webhook events
 */
const createSession = async (
    sessionId,
    res = null,
    options = { usePairingCode: false, phoneNumber: '' },
    onMessageUpsert = null,
    onConnectionUpdate = null,
    onWebhook = null
) => {
    info('SessionManager', 'Creating new session', {
        sessionId,
        usePairingCode: options.usePairingCode,
        phoneNumber: options.phoneNumber,
    })

    const sessionFile = 'md_' + sessionId

    const logger = pino({ level: 'silent' })
    const store = makeInMemoryStore({
        preserveDataDuringSync: true,
        backupBeforeSync: false,
        incrementalSave: true,
        maxMessagesPerChat: 150,
        autoSaveInterval: 10000,
        storeFile: sessionsDir(`${sessionId}_store.json`),
    })

    const { state, saveCreds } = await useMultiFileAuthState(sessionsDir(sessionFile))

    // Fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion()
    info('SessionManager', 'WhatsApp version info', {
        version: version.join('.'),
        isLatest,
    })

    // Load store
    store?.readFromFile(sessionsDir(`${sessionId}_store.json`))
    debug('SessionManager', 'Store loaded from file', {
        sessionId,
        storeFile: `${sessionId}_store.json`,
    })

    // Make both Node and Bun compatible
    const makeWASocket = makeWASocketModule.default ?? makeWASocketModule

    /**
     * @type {import('baileys').AnyWASocket}
     */
    const wa = makeWASocket({
        version,
        printQRInTerminal: false,
        mobile: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage: (key) => {
            if (store) {
                const msg = store.loadMessages(key.remoteJid, key.id)
                return msg?.message || undefined
            }
            return {}
        },
    })
    store?.bind(wa.ev)

    sessions.set(sessionId, { ...wa, store })

    success('SessionManager', 'Session created and stored', {
        sessionId,
    })

    if (options.usePairingCode && !wa.authState.creds.registered) {
        if (!wa.authState.creds.account) {
            await wa.waitForConnectionUpdate((update) => {
                return Boolean(update.qr)
            })
            const code = await wa.requestPairingCode(options.phoneNumber)
            if (res && !res.headersSent && code !== undefined) {
                response(res, 200, true, 'Verify on your phone and enter the provided code.', { code })
            } else {
                response(res, 500, false, 'Unable to create session.')
            }
        }
    }

    wa.ev.on('creds.update', saveCreds)

    // Connection update handler
    wa.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        const statusCode = lastDisconnect?.error?.output?.statusCode

        event('SessionManager', 'Connection update received', {
            sessionId,
            connection,
            statusCode,
        })

        if (onWebhook) {
            onWebhook(sessionId, 'CONNECTION_UPDATE', update)
        }

        if (connection === 'open') {
            retries.delete(sessionId)
            success('SessionManager', 'Connection opened', {
                sessionId,
            })
        }

        if (connection === 'close') {
            warning('SessionManager', 'Connection closed', {
                sessionId,
                statusCode,
                reason: DisconnectReason[statusCode] || 'Unknown',
            })

            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                error('SessionManager', 'Session logged out or max retries reached', {
                    sessionId,
                    statusCode,
                })
                if (res && !res.headersSent) {
                    response(res, 500, false, 'Unable to create session.')
                }

                return deleteSession(sessionId)
            }

            const reconnectDelay = statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0)
            info('SessionManager', 'Scheduling reconnection', {
                sessionId,
                delay: reconnectDelay,
            })

            setTimeout(
                () => {
                    createSession(sessionId, res, options, onMessageUpsert, onConnectionUpdate, onWebhook)
                },
                reconnectDelay,
            )
        }

        if (qr) {
            info('SessionManager', 'QR code received', {
                sessionId,
            })

            if (res && !res.headersSent) {
                if (onWebhook) {
                    onWebhook(sessionId, 'QRCODE_UPDATED', update)
                }

                try {
                    const qrcode = await toDataURL(qr)
                    success('SessionManager', 'QR code generated', {
                        sessionId,
                    })
                    response(res, 200, true, 'QR code received, please scan the QR code.', { qrcode })
                    return
                } catch (err) {
                    error('SessionManager', 'Failed to generate QR code', {
                        sessionId,
                        error: err.message,
                    })
                    response(res, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await wa.logout()
            } catch {
            } finally {
                deleteSession(sessionId)
            }
        }

        if (onConnectionUpdate) {
            onConnectionUpdate(update, sessionId, wa, store)
        }
    })

    // Message upsert handler
    if (onMessageUpsert) {
        wa.ev.on('messages.upsert', onMessageUpsert)
    }

    return wa
}

/**
 * Cleanup function to save all session stores before exit
 */
const cleanup = () => {
    info('SessionManager', 'Running cleanup before exit', {
        totalSessions: sessions.size,
    })

    sessions.forEach((session, sessionId) => {
        try {
            session.store.writeToFile(sessionsDir(`${sessionId}_store.json`))
            debug('SessionManager', 'Session store saved', {
                sessionId,
            })
        } catch (err) {
            error('SessionManager', 'Failed to save session store', {
                sessionId,
                error: err.message,
            })
        }
    })

    success('SessionManager', 'Cleanup completed', {
        totalSessions: sessions.size,
    })
}

/**
 * Initialize and restore all existing sessions from disk
 * 
 * @param {Function} onMessageUpsert - Callback for message upsert events
 * @param {Function} onConnectionUpdate - Callback for connection update events
 * @param {Function} onWebhook - Callback for webhook events
 */
const init = (onMessageUpsert = null, onConnectionUpdate = null, onWebhook = null) => {
    info('SessionManager', 'Initializing session manager', {
        sessionsDir: sessionsDir(),
    })

    readdir(sessionsDir(), (err, files) => {
        if (err) {
            error('SessionManager', 'Failed to read sessions directory', {
                error: err.message,
                sessionsDir: sessionsDir(),
            })
            throw err
        }

        info('SessionManager', 'Found session files', {
            totalFiles: files.length,
        })

        let recoveredCount = 0

        for (const file of files) {
            if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('_store')) {
                continue
            }

            const filename = file.replace('.json', '')
            const sessionId = filename.substring(3)
            info('SessionManager', 'Recovering session', {
                sessionId,
                filename,
            })
            createSession(sessionId, null, {}, onMessageUpsert, onConnectionUpdate, onWebhook)
            recoveredCount++
        }

        success('SessionManager', 'Session initialization completed', {
            recoveredSessions: recoveredCount,
        })
    })
}

export {
    sessions,
    retries,
    msgRetryCounterCache,
    sessionsDir,
    isSessionExists,
    isSessionConnected,
    shouldReconnect,
    getSession,
    getListSessions,
    deleteSession,
    createSession,
    cleanup,
    init,
}
