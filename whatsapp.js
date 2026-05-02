/**
 * WhatsApp Bot Main Module
 * 
 * This is the main entry point for the WhatsApp bot application.
 * It orchestrates all the modular components and provides a unified API.
 * 
 * Architecture:
 * - Session Manager: Handles session lifecycle and management
 * - Message Handler: Processes incoming and outgoing messages
 * - Group Manager: Manages group operations
 * - Profile Manager: Handles profile-related operations
 * - Command Handler: Processes bot commands
 * - Webhook Handler: Manages webhook notifications
 * - Utils: Provides utility functions
 */

// Import all modules
import * as sessionManager from './src/modules/sessionManager.js'

import {
    sendMessage,
    sendMessageWithQueue,
    getMessageStatus,
    getQueueStats,
    getMessagesByStatus,
    clearCompletedMessages,
    readMessage,
    getStoreMessage,
    getMessageMedia,
    convertToBase64,
    filterMessages,
    processMediaForWebhook,
    autoReadMessages,
    updateMessageStatus,
} from './src/modules/messageHandler.js'

import {
    getGroupsWithParticipants,
    participantsUpdate,
    updateSubject,
    updateDescription,
    settingUpdate,
    leave,
    inviteCode,
    revokeInvite,
    metaData,
    acceptInvite,
    getChatList,
    isExists,
} from './src/modules/groupManager.js'

import {
    updateProfileStatus,
    updateProfileName,
    getProfilePicture,
    profilePicture,
    blockAndUnblockUser,
} from './src/modules/profileManager.js'

import {
    handleGroupCommands,
    handleGroupImageMessage,
    handleReportCommand,
    mapAliasKelas,
    isAuthorized,
} from './src/modules/commandHandler.js'

import {
    webhook,
    callWebhook,
    setupEventListeners,
} from './src/modules/webhookHandler.js'

import {
    formatPhone,
    formatGroup,
} from './src/utils/formatters.js'

import {
    info,
    success,
    error,
    warning,
    debug,
    incoming,
    outgoing,
    event,
    separator,
} from './src/utils/logger.js'

import { getAggregateVotesInPollMessage, WAMessageStatus } from 'baileys'
import proto from 'baileys'

/**
 * Bot start time for uptime tracking
 * @type {number}
 */
const BOT_START_TIME = Math.floor(Date.now() / 1000)

/**
 * Track which sessions have been fully set up with event handlers
 * This prevents duplicate handler registration on reconnection
 * @type {Set<string>}
 */
const setupSessions = new Set()

/**
 * Message upsert handler
 * Processes incoming messages and routes them to appropriate handlers
 * 
 * @param {object} m - Message upsert event object
 * @param {string} sessionId - The session ID
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} store - The message store
 */
const handleMessageUpsert = async (m, sessionId, wa, store) => {
    event('WhatsApp', 'messages.upsert event received', {
        sessionId,
        eventType: m.type,
        messageCount: m.messages.length,
    })

    // Only process new messages (notify type)
    if (m.type !== 'notify') {
        debug('WhatsApp', 'Skipping non-notify event', {
            sessionId,
            eventType: m.type,
        })
        return
    }

    // Always get the latest session to avoid stale references after reconnection
    const currentWa = sessionManager.getSession(sessionId) || wa
    const currentStore = currentWa?.store || store

    // Filter messages
    const messages = filterMessages(m.messages)

    debug('WhatsApp', 'Messages after filtering', {
        sessionId,
        totalMessages: m.messages.length,
        filteredMessages: messages.length,
    })

    if (messages.length === 0) {
        debug('WhatsApp', 'No messages to process', {
            sessionId,
        })
        return
    }

    // Auto read messages if enabled
    await autoReadMessages(currentWa, messages)

    // Process each message
    const messageTmp = await Promise.all(
        messages.map(async (msg) => {
            try {
                debug('WhatsApp', 'Processing message', {
                    sessionId,
                    messageId: msg.key.id,
                    from: msg.key.remoteJid,
                })

                const typeMessage = Object.keys(msg.message)[0]
                debug('WhatsApp', 'Message type detected', {
                    sessionId,
                    messageType: typeMessage,
                })

                // Update message status
                updateMessageStatus(msg)

                // Handle image messages from groups
                if (typeMessage === 'imageMessage' && msg.key.remoteJid.endsWith('@g.us')) {
                    debug('WhatsApp', 'Image message detected in group', {
                        sessionId,
                        groupId: msg.key.remoteJid,
                    })
                    await handleGroupImageMessage(currentWa, msg, sessionId)
                    debug('WhatsApp', 'handleGroupImageMessage completed', {
                        sessionId,
                    })
                }

                // Handle text commands from groups
                if (
                    msg.key.remoteJid.endsWith('@g.us') &&
                    (typeMessage === 'conversation' || typeMessage === 'extendedTextMessage')
                ) {
                    debug('WhatsApp', 'Text message detected in group', {
                        sessionId,
                        groupId: msg.key.remoteJid,
                    })

                    const handled = await handleGroupCommands(currentWa, msg, sessionId)

                    if (handled) {
                        debug('WhatsApp', 'Message processed as command', {
                            sessionId,
                        })
                        return
                    } else {
                        debug('WhatsApp', 'Message is not a command, continuing normal processing', {
                            sessionId,
                        })
                    }
                }

                // Process media for webhook if enabled
                if (
                    ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage'].includes(typeMessage) &&
                    process.env.APP_WEBHOOK_FILE_IN_BASE64 === 'true'
                ) {
                    return await processMediaForWebhook(currentWa, msg, typeMessage)
                }

                debug('WhatsApp', 'Message processing completed', {
                    sessionId,
                    messageId: msg.key.id,
                })
                return msg

            } catch (err) {
                error('WhatsApp', 'Failed to process message', {
                    sessionId,
                    messageId: msg.key.id,
                    error: err.message,
                })
                return {}
            }
        }),
    )

    debug('WhatsApp', 'Sending data to webhook', {
        sessionId,
        messageCount: messageTmp.length,
    })

    // Send incoming messages to webhook
    callWebhook(sessionId, 'MESSAGES_UPSERT', messageTmp)
    
    // Log incoming messages for visibility
    if (messageTmp.length > 0) {
        incoming('WhatsApp', `Received ${messageTmp.length} new message(s)`, {
            sessionId,
            messages: messageTmp.filter(msg => msg && msg.key).map(msg => ({
                id: msg.key?.id,
                from: msg.key?.remoteJid,
                type: Object.keys(msg.message || {})[0],
                timestamp: msg.messageTimestamp
            }))
        })
    }
}

/**
 * Connection update handler
 * Handles connection state changes and reconnection logic
 * Re-registers event listeners after successful reconnection
 * 
 * @param {object} update - Connection update object
 * @param {string} sessionId - The session ID
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} store - The message store
 */
const handleConnectionUpdate = async (update, sessionId, wa, store) => {
    const { connection, lastDisconnect } = update

    event('WhatsApp', 'Connection update received', {
        sessionId,
        connection,
        statusCode: lastDisconnect?.error?.output?.statusCode,
    })

    if (connection === 'open') {
        // Always get the latest session from sessionManager to ensure
        // we're working with the current socket (not a stale reference)
        const currentWa = sessionManager.getSession(sessionId) || wa

        // When connection is open (or re-opened after reconnection),
        // we need to ensure all event handlers are properly registered
        // The sessionManager already handles the socket creation,
        // but we need to re-register the additional event listeners
        // that are set up in createSession() from this module
        if (setupSessions.has(sessionId)) {
            // Session was already set up, but reconnected - re-register handlers
            info('WhatsApp', 'Session reconnected, re-registering event handlers', {
                sessionId,
            })
            registerSessionHandlers(sessionId, currentWa)
        }
    }

    if (connection === 'close') {
        warning('WhatsApp', 'Connection closed, sessionManager will handle reconnection', {
            sessionId,
            statusCode: lastDisconnect?.error?.output?.statusCode,
        })
    }
}

/**
 * Register all event handlers for a session
 * This is called both on initial creation and after reconnection
 *
 * @param {string} sessionId - The session ID
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 */
const registerSessionHandlers = (sessionId, wa) => {
    // Remove existing listeners to prevent duplicates
    wa.ev.removeAllListeners('messages.update')
    wa.ev.removeAllListeners('message-receipt.update')
    wa.ev.removeAllListeners('messages.upsert')

    // Re-register messages.upsert handler (critical for message detection)
    wa.ev.on('messages.upsert', (m) => handleMessageUpsert(m, sessionId, wa, wa.store))

    // Setup messages.update handler
    wa.ev.on('messages.update', async (m) => {
        debug('WhatsApp', 'messages.update event received', {
            sessionId,
            updateCount: m.length,
        })

        for (const { key, update } of m) {
            const getMessage = (key) => {
                if (wa.store) {
                    const msg = wa.store.loadMessages(key.remoteJid, key.id)
                    return msg?.message || undefined
                }
                return proto.Message.fromObject({})
            }

            const msg = await getMessage(key)

            if (!msg) {
                debug('WhatsApp', 'Message not found in store', {
                    sessionId,
                    messageId: key.id,
                })
                continue
            }

            update.status = WAMessageStatus[update.status]
            const messagesUpdate = [
                {
                    key,
                    update,
                    message: msg,
                },
            ]
            callWebhook(sessionId, 'MESSAGES_UPDATE', messagesUpdate)
        }
    })

    // Setup message-receipt.update handler
    wa.ev.on('message-receipt.update', async (m) => {
        debug('WhatsApp', 'message-receipt.update event received', {
            sessionId,
            receiptCount: m.length,
        })

        const getMessage = (key) => {
            if (wa.store) {
                const msg = wa.store.loadMessages(key.remoteJid, key.id)
                return msg?.message || undefined
            }
            return proto.Message.fromObject({})
        }

        for (const { key, messageTimestamp, pushName, broadcast, update } of m) {
            if (update?.pollUpdates) {
                const pollCreation = await getMessage(key)
                if (pollCreation) {
                    const pollMessage = await getAggregateVotesInPollMessage({
                        message: pollCreation,
                        pollUpdates: update.pollUpdates,
                    })
                    update.pollUpdates[0].vote = pollMessage
                    callWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', [
                        { key, messageTimestamp, pushName, broadcast, update },
                    ])
                    return
                }
            }
        }

        callWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', m)
    })

    // Setup additional event listeners (webhook events)
    // Remove existing webhook listeners first to prevent duplicates
    const webhookEvents = [
        'chats.set', 'chats.upsert', 'chats.delete', 'chats.update',
        'labels.association', 'labels.edit',
        'messages.delete', 'messages.reaction', 'messages.media-update',
        'messaging-history.set',
        'groups.upsert', 'groups.update', 'group-participants.update',
        'blocklist.set', 'blocklist.update',
        'contacts.set', 'contacts.upsert', 'contacts.update',
        'presence.update',
    ]
    
    for (const eventName of webhookEvents) {
        wa.ev.removeAllListeners(eventName)
    }
    
    setupEventListeners(wa, sessionId, (instance, type, data) => callWebhook(instance, type, data))

    debug('WhatsApp', 'All session handlers registered', {
        sessionId,
    })
}

/**
 * Create a new WhatsApp session with all handlers
 *
 * @param {string} sessionId - Unique identifier for the session
 * @param {object} res - Express response object (optional)
 * @param {object} options - Session creation options
 * @param {boolean} options.usePairingCode - Whether to use pairing code instead of QR
 * @param {string} options.phoneNumber - Phone number for pairing code
 * @returns {Promise<import('baileys').AnyWASocket>} The created session
 */
const createSession = async (
    sessionId,
    res = null,
    options = { usePairingCode: false, phoneNumber: '' }
) => {
    info('WhatsApp', 'Creating new session with handlers', {
        sessionId,
        usePairingCode: options.usePairingCode,
        phoneNumber: options.phoneNumber,
    })

    // Store callbacks in sessionManager so reconnection uses the correct handlers
    // These callbacks use sessionManager.getSession() internally to avoid stale references
    const onMessageUpsert = (m) => {
        const currentWa = sessionManager.getSession(sessionId)
        handleMessageUpsert(m, sessionId, currentWa, currentWa?.store)
    }
    const onConnectionUpdate = (update) => {
        const currentWa = sessionManager.getSession(sessionId)
        handleConnectionUpdate(update, sessionId, currentWa, currentWa?.store)
    }
    const onWebhook = (instance, type, data) => callWebhook(instance, type, data)

    // Update callbacks in sessionManager before creating the session
    sessionManager.updateCallbacks(sessionId, onMessageUpsert, onConnectionUpdate, onWebhook)

    const wa = await sessionManager.createSession(
        sessionId,
        res,
        options,
        onMessageUpsert,
        onConnectionUpdate,
        onWebhook
    )

    // Register all session handlers
    registerSessionHandlers(sessionId, wa)

    // Mark session as set up
    setupSessions.add(sessionId)

    success('WhatsApp', 'Session created with all handlers', {
        sessionId,
    })

    return wa
}

/**
 * Initialize the WhatsApp bot and restore all existing sessions
 */
const init = () => {
    info('WhatsApp', 'Initializing WhatsApp bot', {
        botStartTime: new Date(BOT_START_TIME * 1000).toISOString(),
    })

    // Pass null callbacks to sessionManager.init() - they will be set up properly
    // in the setTimeout below after sessions are restored
    sessionManager.init(
        null,
        null,
        (instance, type, data) => {
            callWebhook(instance, type, data)
        }
    )

    // After sessions are restored, we need to set up proper handlers for each session
    setTimeout(() => {
        const sessionIds = sessionManager.getListSessions()
        info('WhatsApp', 'Setting up handlers for restored sessions', {
            sessionCount: sessionIds.length,
        })

        sessionIds.forEach(sessionId => {
            const wa = sessionManager.getSession(sessionId)
            if (wa) {
                // Create proper callbacks that always get the latest session reference
                const onMessageUpsert = (m) => {
                    const currentWa = sessionManager.getSession(sessionId)
                    handleMessageUpsert(m, sessionId, currentWa, currentWa?.store)
                }
                const onConnectionUpdate = (update) => {
                    const currentWa = sessionManager.getSession(sessionId)
                    handleConnectionUpdate(update, sessionId, currentWa, currentWa?.store)
                }
                const onWebhook = (instance, type, data) => callWebhook(instance, type, data)

                // Update callbacks in sessionManager for reconnection use
                sessionManager.updateCallbacks(sessionId, onMessageUpsert, onConnectionUpdate, onWebhook)

                // Remove existing messages.upsert listeners and add proper handler
                wa.ev.removeAllListeners('messages.upsert')
                wa.ev.on('messages.upsert', onMessageUpsert)

                // Remove existing connection.update listeners and add proper handler
                wa.ev.removeAllListeners('connection.update')
                wa.ev.on('connection.update', onConnectionUpdate)

                // Register all other session handlers
                registerSessionHandlers(sessionId, wa)

                // Mark session as set up
                setupSessions.add(sessionId)

                success('WhatsApp', 'Handlers set up for restored session', {
                    sessionId,
                })
            }
        })

        success('WhatsApp', 'WhatsApp bot initialized successfully')
    }, 1000) // Wait 1 second for sessions to be fully restored
}

// Export all functions for backward compatibility and external use
export const isSessionExists = sessionManager.isSessionExists
export const getSession = sessionManager.getSession
export const getListSessions = sessionManager.getListSessions
export const deleteSession = sessionManager.deleteSession
export const isSessionConnected = sessionManager.isSessionConnected
export const cleanup = sessionManager.cleanup
export const sessions = sessionManager.sessions
export const retries = sessionManager.retries
export const msgRetryCounterCache = sessionManager.msgRetryCounterCache
export const sessionsDir = sessionManager.sessionsDir
export const shouldReconnect = sessionManager.shouldReconnect

export {
    createSession,
    init,
    sendMessage,
    sendMessageWithQueue,
    getMessageStatus,
    getQueueStats,
    getMessagesByStatus,
    clearCompletedMessages,
    readMessage,
    getStoreMessage,
    getMessageMedia,
    convertToBase64,
    getChatList,
    getGroupsWithParticipants,
    isExists,
    participantsUpdate,
    updateSubject,
    updateDescription,
    settingUpdate,
    leave,
    inviteCode,
    revokeInvite,
    metaData,
    acceptInvite,
    updateProfileStatus,
    updateProfileName,
    getProfilePicture,
    profilePicture,
    blockAndUnblockUser,
    formatPhone,
    formatGroup,
    handleGroupCommands,
    handleGroupImageMessage,
    handleReportCommand,
    mapAliasKelas,
    isAuthorized,
    webhook,
    callWebhook,
    setupEventListeners,
    handleMessageUpsert,
    handleConnectionUpdate,
    BOT_START_TIME,
}
