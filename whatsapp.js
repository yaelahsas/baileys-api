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
    await autoReadMessages(wa, messages)

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
                    await handleGroupImageMessage(wa, msg, sessionId)
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

                    const handled = await handleGroupCommands(wa, msg, sessionId)

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
                    return await processMediaForWebhook(wa, msg, typeMessage)
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

    callWebhook(sessionId, 'MESSAGES_UPSERT', messageTmp)
}

/**
 * Connection update handler
 * Handles connection state changes and reconnection logic
 * 
 * @param {object} update - Connection update object
 * @param {string} sessionId - The session ID
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} store - The message store
 */
const handleConnectionUpdate = async (update, sessionId, wa, store) => {
    event('WhatsApp', 'Connection update received', {
        sessionId,
        connection: update.connection,
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

    const wa = await sessionManager.createSession(
        sessionId,
        res,
        options,
        (m) => handleMessageUpsert(m, sessionId, wa, wa.store),
        (update) => handleConnectionUpdate(update, sessionId, wa, wa.store),
        (instance, type, data) => callWebhook(instance, type, data)
    )

    // Setup additional event listeners
    setupEventListeners(wa, sessionId, (instance, type, data) => callWebhook(instance, type, data))

    success('WhatsApp', 'Session created with all handlers', {
        sessionId,
    })

    // Handle message updates with poll aggregation
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

    // Handle message receipt updates with poll aggregation
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

    return wa
}

/**
 * Initialize the WhatsApp bot and restore all existing sessions
 */
const init = () => {
    info('WhatsApp', 'Initializing WhatsApp bot', {
        botStartTime: new Date(BOT_START_TIME * 1000).toISOString(),
    })

    sessionManager.init(
        (m) => {
            // Message upsert handler will be set per session
        },
        (update) => {
            // Connection update handler will be set per session
        },
        (instance, type, data) => {
            callWebhook(instance, type, data)
        }
    )

    success('WhatsApp', 'WhatsApp bot initialized successfully')
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
