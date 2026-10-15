/**
 * Session Manager Module
 *
 * This module handles all session-related operations including:
 * - Creating new WhatsApp sessions
 * - Managing session lifecycle
 * - Session validation and status checking
 * - Session cleanup and deletion
 * - Auto-reconnection with keep-alive mechanism
 * - Connection health monitoring
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
import makeSQLiteStore from '../../store/sqlite-store.js'
import { toDataURL } from 'qrcode'
import __dirname from '../../dirname.js'
import response from '../../response.js'
import NodeCache from 'node-cache'
import { info, success, error, warning, debug, event } from '../utils/logger.js'

/**
 * Session storage maps
 * @type {Map<string, any>}
 */
const sessions = new Map()
const retries = new Map()

/**
 * Stored callbacks per session for reconnection
 * This ensures that when a session reconnects, the correct callbacks are used
 * instead of stale closure references
 * @type {Map<string, { onMessageUpsert: Function, onConnectionUpdate: Function, onWebhook: Function }>}
 */
const sessionCallbacks = new Map()

/**
 * Keep-alive interval timers per session
 * @type {Map<string, NodeJS.Timeout>}
 */
const keepAliveTimers = new Map()

/**
 * Connection monitoring timers per session
 * @type {Map<string, NodeJS.Timeout>}
 */
const connectionMonitorTimers = new Map()

/**
 * Track consecutive failed keep-alive pings per session
 * Used to detect silent connection death (zombie connections)
 * @type {Map<string, number>}
 */
const failedPingCounters = new Map()

/**
 * Track last successful keep-alive timestamp per session
 * Used to detect how long since last successful server response
 * @type {Map<string, number>}
 */
const lastSuccessfulPing = new Map()

/**
 * Keep-alive configuration from environment
 */
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL ?? 25000) // 25 seconds default
const CONNECTION_CHECK_INTERVAL = parseInt(process.env.CONNECTION_CHECK_INTERVAL ?? 60000) // 60 seconds default
const MAX_FAILED_PINGS = parseInt(process.env.MAX_FAILED_PINGS ?? 3) // Force reconnect after 3 consecutive failures
const STALE_CONNECTION_TIMEOUT = parseInt(process.env.STALE_CONNECTION_TIMEOUT ?? 300000) // 5 minutes - no successful ping = stale

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
    const maxRetries = parseInt(process.env.MAX_RETRIES ?? -1)
    let attempts = retries.get(sessionId) ?? 0

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
 * Stop keep-alive and connection monitoring timers for a session
 *
 * @param {string} sessionId - The session ID to stop timers for
 */
const stopKeepAlive = (sessionId) => {
    const keepAliveTimer = keepAliveTimers.get(sessionId)
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
        keepAliveTimers.delete(sessionId)
        debug('SessionManager', 'Keep-alive timer stopped', { sessionId })
    }

    const monitorTimer = connectionMonitorTimers.get(sessionId)
    if (monitorTimer) {
        clearInterval(monitorTimer)
        connectionMonitorTimers.delete(sessionId)
        debug('SessionManager', 'Connection monitor timer stopped', { sessionId })
    }

    // Clean up ping tracking data
    failedPingCounters.delete(sessionId)
    lastSuccessfulPing.delete(sessionId)
}

/**
 * Force reconnect a session that has become stale (zombie connection)
 * This is called when keep-alive pings fail consecutively or connection is stale
 *
 * @param {string} sessionId - The session ID
 * @param {string} reason - The reason for forcing reconnect
 */
const forceReconnect = (sessionId, reason) => {
    warning('SessionManager', 'Force reconnecting stale session', {
        sessionId,
        reason,
    })

    const session = sessions.get(sessionId)
    if (!session) {
        error('SessionManager', 'Cannot force reconnect - session not found', {
            sessionId,
        })
        return
    }

    // Stop keep-alive timers first
    stopKeepAlive(sessionId)

    // Remove session from active sessions map
    sessions.delete(sessionId)

    // Attempt to close the socket gracefully
    try {
        if (session.ws?.socket) {
            session.ws.socket.close()
        }
    } catch (e) {
        debug('SessionManager', 'Error closing socket during force reconnect', {
            sessionId,
            error: e.message,
        })
    }

    // Schedule reconnection with a short delay
    const reconnectDelay = 2000 // 2 seconds
    info('SessionManager', 'Scheduling forced reconnection', {
        sessionId,
        delay: reconnectDelay,
        reason,
    })

    setTimeout(() => {
        // Get stored options for reconnection
        const existingCallbacks = sessionCallbacks.get(sessionId)
        createSession(
            sessionId,
            null,
            {},
            existingCallbacks?.onMessageUpsert || null,
            existingCallbacks?.onConnectionUpdate || null,
            existingCallbacks?.onWebhook || null,
            true, // isReconnect
        )
    }, reconnectDelay)
}

/**
 * Start keep-alive mechanism for a session
 * Sends periodic ping/keep-alive requests to prevent the connection from being closed due to inactivity.
 * Tracks consecutive ping failures and forces reconnection when threshold is reached.
 *
 * @param {string} sessionId - The session ID
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp socket instance
 */
const startKeepAlive = (sessionId, wa) => {
    // Stop any existing timers first
    stopKeepAlive(sessionId)

    // Initialize ping tracking
    failedPingCounters.set(sessionId, 0)
    lastSuccessfulPing.set(sessionId, Date.now())

    // Keep-alive: periodically check connection and send presence update
    // Track success/failure to detect silent connection death
    const keepAliveTimer = setInterval(() => {
        try {
            const currentSession = sessions.get(sessionId)
            if (!currentSession) {
                debug('SessionManager', 'Session no longer exists, stopping keep-alive', { sessionId })
                stopKeepAlive(sessionId)
                return
            }

            const isConnected = currentSession.ws?.socket?.readyState === 1
            if (!isConnected) {
                warning('SessionManager', 'Keep-alive detected disconnected socket', {
                    sessionId,
                    readyState: currentSession.ws?.socket?.readyState,
                })
                // Increment failed ping counter
                const failedPings = (failedPingCounters.get(sessionId) || 0) + 1
                failedPingCounters.set(sessionId, failedPings)

                if (failedPings >= MAX_FAILED_PINGS) {
                    error('SessionManager', `Max failed pings (${MAX_FAILED_PINGS}) reached, forcing reconnect`, {
                        sessionId,
                        failedPings,
                    })
                    clearInterval(keepAliveTimer)
                    keepAliveTimers.delete(sessionId)
                    forceReconnect(sessionId, `keep-alive-failed-${failedPings}-pings`)
                }
                return
            }

            debug('SessionManager', 'Keep-alive ping', {
                sessionId,
                readyState: currentSession.ws?.socket?.readyState,
                failedPings: failedPingCounters.get(sessionId) || 0,
            })

            // Send presence update as keep-alive ping with response verification
            currentSession
                .sendPresenceUpdate('available')
                .then(() => {
                    // Successful ping - reset counter
                    failedPingCounters.set(sessionId, 0)
                    lastSuccessfulPing.set(sessionId, Date.now())
                    debug('SessionManager', 'Keep-alive ping successful', {
                        sessionId,
                    })
                })
                .catch((err) => {
                    warning('SessionManager', 'Keep-alive presence update failed', {
                        sessionId,
                        error: err.message,
                    })
                    // Increment failed ping counter
                    const failedPings = (failedPingCounters.get(sessionId) || 0) + 1
                    failedPingCounters.set(sessionId, failedPings)

                    if (failedPings >= MAX_FAILED_PINGS) {
                        error('SessionManager', `Max failed pings (${MAX_FAILED_PINGS}) reached, forcing reconnect`, {
                            sessionId,
                            failedPings,
                        })
                        clearInterval(keepAliveTimer)
                        keepAliveTimers.delete(sessionId)
                        forceReconnect(sessionId, `keep-alive-failed-${failedPings}-pings`)
                    }
                })
        } catch (err) {
            warning('SessionManager', 'Keep-alive check error', {
                sessionId,
                error: err.message,
            })
            // Increment failed ping counter for errors too
            const failedPings = (failedPingCounters.get(sessionId) || 0) + 1
            failedPingCounters.set(sessionId, failedPings)

            if (failedPings >= MAX_FAILED_PINGS) {
                error(
                    'SessionManager',
                    `Max failed pings (${MAX_FAILED_PINGS}) reached after error, forcing reconnect`,
                    {
                        sessionId,
                        failedPings,
                    },
                )
                clearInterval(keepAliveTimer)
                keepAliveTimers.delete(sessionId)
                forceReconnect(sessionId, `keep-alive-error-${failedPings}-pings`)
            }
        }
    }, KEEP_ALIVE_INTERVAL)

    keepAliveTimers.set(sessionId, keepAliveTimer)

    // Connection monitor: periodically check if the connection is still alive
    // Uses lastSuccessfulPing to detect stale connections that appear connected but are dead
    const monitorTimer = setInterval(() => {
        try {
            const session = sessions.get(sessionId)
            if (!session) {
                debug('SessionManager', 'Session no longer exists, stopping monitor', { sessionId })
                stopKeepAlive(sessionId)
                return
            }

            const isConnected = session.ws?.socket?.readyState === 1
            const lastPing = lastSuccessfulPing.get(sessionId) || 0
            const timeSinceLastPing = Date.now() - lastPing
            const failedPings = failedPingCounters.get(sessionId) || 0

            if (!isConnected) {
                warning('SessionManager', 'Connection monitor detected disconnected socket', {
                    sessionId,
                    readyState: session.ws?.socket?.readyState,
                    failedPings,
                })
                // Connection update handler should handle reconnection
                // But if it doesn't fire, force reconnect
                if (failedPings >= MAX_FAILED_PINGS) {
                    forceReconnect(sessionId, 'monitor-detected-disconnected')
                }
            } else if (timeSinceLastPing > STALE_CONNECTION_TIMEOUT) {
                // Socket appears connected but no successful ping in a long time
                // This is the "zombie connection" scenario
                error('SessionManager', 'Connection appears connected but is stale (no successful ping)', {
                    sessionId,
                    timeSinceLastPing: `${Math.round(timeSinceLastPing / 1000)}s`,
                    staleTimeout: `${STALE_CONNECTION_TIMEOUT / 1000}s`,
                    failedPings,
                })
                forceReconnect(sessionId, `stale-connection-${Math.round(timeSinceLastPing / 1000)}s`)
            } else {
                debug('SessionManager', 'Connection monitor: session is healthy', {
                    sessionId,
                    timeSinceLastPing: `${Math.round(timeSinceLastPing / 1000)}s`,
                    failedPings,
                })
            }
        } catch (err) {
            warning('SessionManager', 'Connection monitor error', {
                sessionId,
                error: err.message,
            })
        }
    }, CONNECTION_CHECK_INTERVAL)

    connectionMonitorTimers.set(sessionId, monitorTimer)

    info('SessionManager', 'Keep-alive and connection monitor started', {
        sessionId,
        keepAliveInterval: KEEP_ALIVE_INTERVAL,
        connectionCheckInterval: CONNECTION_CHECK_INTERVAL,
        maxFailedPings: MAX_FAILED_PINGS,
        staleConnectionTimeout: `${STALE_CONNECTION_TIMEOUT / 1000}s`,
    })
}

/**
 * Delete a session and clean up all associated files and timers
 *
 * @param {string} sessionId - The session ID to delete
 */
const deleteSession = (sessionId) => {
    info('SessionManager', 'Deleting session', {
        sessionId,
    })

    // Stop keep-alive and monitoring timers
    stopKeepAlive(sessionId)

    const sessionFile = 'md_' + sessionId
    const storeFile = `${sessionId}_store.json`
    const rmOptions = { force: true, recursive: true }

    try {
        rmSync(sessionsDir(sessionFile), rmOptions)
        rmSync(sessionsDir(storeFile), rmOptions)

        sessions.delete(sessionId)
        retries.delete(sessionId)
        sessionCallbacks.delete(sessionId)

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
 * Update callbacks for a session (used by whatsapp.js to set proper handlers)
 *
 * @param {string} sessionId - The session ID
 * @param {Function} onMessageUpsert - Callback for message upsert events
 * @param {Function} onConnectionUpdate - Callback for connection update events
 * @param {Function} onWebhook - Callback for webhook events
 */
const updateCallbacks = (sessionId, onMessageUpsert, onConnectionUpdate, onWebhook) => {
    sessionCallbacks.set(sessionId, { onMessageUpsert, onConnectionUpdate, onWebhook })
    debug('SessionManager', 'Callbacks updated for session', { sessionId })
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
 * @param {boolean} isReconnect - Whether this is a reconnection attempt
 */
const createSession = async (
    sessionId,
    res = null,
    options = { usePairingCode: false, phoneNumber: '' },
    onMessageUpsert = null,
    onConnectionUpdate = null,
    onWebhook = null,
    isReconnect = false,
) => {
    info('SessionManager', isReconnect ? 'Reconnecting session' : 'Creating new session', {
        sessionId,
        usePairingCode: options.usePairingCode,
        phoneNumber: options.phoneNumber,
        isReconnect,
    })

    // Store callbacks for reconnection use (prefer new ones, but keep existing if not provided)
    const existingCallbacks = sessionCallbacks.get(sessionId)
    const effectiveOnMessageUpsert = onMessageUpsert || existingCallbacks?.onMessageUpsert
    const effectiveOnConnectionUpdate = onConnectionUpdate || existingCallbacks?.onConnectionUpdate
    const effectiveOnWebhook = onWebhook || existingCallbacks?.onWebhook

    if (effectiveOnMessageUpsert || effectiveOnConnectionUpdate || effectiveOnWebhook) {
        sessionCallbacks.set(sessionId, {
            onMessageUpsert: effectiveOnMessageUpsert,
            onConnectionUpdate: effectiveOnConnectionUpdate,
            onWebhook: effectiveOnWebhook,
        })
    }

    // Stop any existing keep-alive timers before creating new session
    stopKeepAlive(sessionId)

    const sessionFile = 'md_' + sessionId

    const logger = pino({ level: 'silent' })
    const storeFile = sessionsDir(`${sessionId}_store.json`)
    const useSQLiteStore = (process.env.MESSAGE_STORE_TYPE || 'memory').toLowerCase() === 'sqlite'
    const store = useSQLiteStore
        ? makeSQLiteStore({
              dbFile: sessionsDir(`${sessionId}_messages.db`),
              retentionDays: parseInt(process.env.MESSAGE_RETENTION_DAYS || '90'),
          })
        : makeInMemoryStore({
              preserveDataDuringSync: true,
              backupBeforeSync: false,
              incrementalSave: true,
              maxMessagesPerChat: 150,
              autoSaveInterval: 10000,
              storeFile,
          })

    const { state, saveCreds } = await useMultiFileAuthState(sessionsDir(sessionFile))

    // Fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion()
    info('SessionManager', 'WhatsApp version info', {
        version: version.join('.'),
        isLatest,
    })

    // Load store
    await store?.readFromFile(storeFile)
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
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,

        markOnlineOnConnect: true,
        syncFullHistory: false,

        getMessage: async (key) => {
            if (store) {
                const messages = await store.loadMessages(key.remoteJid, key.id)
                return messages?.[0]?.message || undefined
            }
            return {}
        },
        // Enable keep-alive on the WebSocket
        connectOptions: {
            keepAlive: true,
        },
    })
    store?.bind(wa.ev)

    sessions.set(sessionId, { ...wa, store })

    success('SessionManager', isReconnect ? 'Session reconnected and stored' : 'Session created and stored', {
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
            reason: statusCode ? DisconnectReason[statusCode] || 'Unknown' : undefined,
        })

        // Always use the latest stored callbacks (they may have been updated by whatsapp.js)
        const currentCallbacks = sessionCallbacks.get(sessionId)
        const currentOnWebhook = currentCallbacks?.onWebhook || effectiveOnWebhook
        const currentOnConnectionUpdate = currentCallbacks?.onConnectionUpdate || effectiveOnConnectionUpdate
        const currentOnMessageUpsert = currentCallbacks?.onMessageUpsert || effectiveOnMessageUpsert

        if (currentOnWebhook) {
            currentOnWebhook(sessionId, 'CONNECTION_UPDATE', update)
        }

        if (connection === 'open') {
            retries.delete(sessionId)

            // Start keep-alive mechanism when connection is open
            startKeepAlive(sessionId, wa)

            success('SessionManager', 'Connection opened', {
                sessionId,
            })
        }

        if (connection === 'close') {
            // Stop keep-alive when connection closes
            stopKeepAlive(sessionId)

            warning('SessionManager', 'Connection closed', {
                sessionId,
                statusCode,
                reason: DisconnectReason[statusCode] || 'Unknown',
            })

            // Determine if this is a logged out scenario
            const isLoggedOut =
                statusCode === DisconnectReason.loggedOut ||
                statusCode === DisconnectReason.badSession ||
                statusCode === DisconnectReason.forbidden

            if (isLoggedOut || !shouldReconnect(sessionId)) {
                error('SessionManager', 'Session logged out or max retries reached', {
                    sessionId,
                    statusCode,
                    reason: DisconnectReason[statusCode] || 'Unknown',
                })
                if (res && !res.headersSent) {
                    response(res, 500, false, 'Unable to create session.')
                }

                return deleteSession(sessionId)
            }

            // Calculate reconnection delay with exponential backoff
            const baseDelay = parseInt(process.env.RECONNECT_INTERVAL ?? 5000)
            const attemptCount = retries.get(sessionId) ?? 1
            const reconnectDelay =
                statusCode === DisconnectReason.restartRequired
                    ? 1000 // Quick reconnect for restart required
                    : Math.min(baseDelay * Math.pow(1.5, attemptCount - 1), 60000) // Exponential backoff, max 60s

            info('SessionManager', 'Scheduling reconnection', {
                sessionId,
                delay: Math.round(reconnectDelay),
                attempt: attemptCount,
                statusCode,
                reason: DisconnectReason[statusCode] || 'Unknown',
            })

            setTimeout(() => {
                // Use null for callbacks - createSession will use stored callbacks from sessionCallbacks
                createSession(sessionId, null, options, null, null, null, true)
            }, reconnectDelay)
        }

        if (qr) {
            info('SessionManager', 'QR code received', {
                sessionId,
            })

            if (res && !res.headersSent) {
                if (currentOnWebhook) {
                    currentOnWebhook(sessionId, 'QRCODE_UPDATED', update)
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

        if (currentOnConnectionUpdate) {
            // Always pass the current wa from sessions map to avoid stale references
            const currentWa = sessions.get(sessionId) || wa
            currentOnConnectionUpdate(update, sessionId, currentWa, currentWa.store || store)
        }
    })

    // Message upsert handler - use effective callbacks (resolved from params or stored callbacks)
    if (effectiveOnMessageUpsert) {
        wa.ev.on('messages.upsert', effectiveOnMessageUpsert)
    }

    return wa
}

/**
 * Cleanup function to save all session stores and stop timers before exit
 */
const cleanup = () => {
    info('SessionManager', 'Running cleanup before exit', {
        totalSessions: sessions.size,
    })

    // Stop all keep-alive and monitoring timers
    for (const sessionId of keepAliveTimers.keys()) {
        stopKeepAlive(sessionId)
    }

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
        maxRetries: process.env.MAX_RETRIES ?? -1,
        reconnectInterval: process.env.RECONNECT_INTERVAL ?? 5000,
        keepAliveInterval: KEEP_ALIVE_INTERVAL,
        connectionCheckInterval: CONNECTION_CHECK_INTERVAL,
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
            createSession(sessionId, null, {}, onMessageUpsert, onConnectionUpdate, onWebhook, false)
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
    startKeepAlive,
    stopKeepAlive,
    updateCallbacks,
    forceReconnect,
}
