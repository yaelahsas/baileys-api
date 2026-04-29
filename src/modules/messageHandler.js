/**
 * Message Handler Module
 *
 * This module handles all message-related operations including:
 * - Sending messages
 * - Reading messages
 * - Processing media messages
 * - Message filtering and validation
 */

import { downloadMediaMessage, delay, WAMessageStatus } from 'baileys'
import { messageQueue, MessageStatus } from './messageQueue.js'
import {
    info,
    success,
    error,
    incoming,
    outgoing,
    debug,
    messageFlow,
} from '../utils/logger.js'

/**
 * Send a message to a recipient
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} receiver - The recipient's JID
 * @param {object} message - The message content
 * @param {object} options - Additional message options
 * @param {number} delayMs - Delay before sending in milliseconds
 * @returns {Promise<object>} The sent message object
 */
const sendMessage = async (session, receiver, message, options = {}, delayMs = 1000) => {
    try {
        const messageType = Object.keys(message)[0] || 'unknown'
        const messageId = options?.id || 'unknown'
        
        outgoing('MessageHandler', 'Preparing to send message', {
            messageId,
            receiver,
            messageType,
            delayMs,
        })
        
        await delay(parseInt(delayMs))
        const result = await session.sendMessage(receiver, message, options)
        
        success('MessageHandler', 'Message sent successfully', {
            messageId,
            receiver,
            messageType,
        })
        
        return result
    } catch (err) {
        error('MessageHandler', 'Failed to send message', {
            receiver,
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Send a message using the queue system (recommended for concurrent requests)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} receiver - The recipient's JID
 * @param {object} message - The message content
 * @param {object} options - Additional message options
 * @param {number} delayMs - Delay before sending in milliseconds
 * @returns {string} Queue item ID for tracking
 */
const sendMessageWithQueue = (session, receiver, message, options = {}, delayMs = 1000) => {
    const messageType = Object.keys(message)[0] || 'unknown'
    
    outgoing('MessageHandler', 'Adding message to queue', {
        receiver,
        messageType,
        delayMs,
    })
    
    return messageQueue.enqueue(session, receiver, message, options, delayMs)
}

/**
 * Get the status of a queued message
 * 
 * @param {string} queueId - The queue item ID
 * @returns {object|null} Queue item status or null if not found
 */
const getMessageStatus = (queueId) => {
    return messageQueue.getStatus(queueId)
}

/**
 * Get queue statistics
 * 
 * @returns {object} Queue statistics
 */
const getQueueStats = () => {
    return messageQueue.getStats()
}

/**
 * Get all messages with a specific status
 * 
 * @param {string} status - The status to filter by (pending, processing, sent, failed)
 * @returns {Array<object>} Array of queue items with the specified status
 */
const getMessagesByStatus = (status) => {
    return messageQueue.getItemsByStatus(status)
}

/**
 * Clear all completed messages from the queue
 * 
 * @returns {number} Number of items cleared
 */
const clearCompletedMessages = () => {
    return messageQueue.clearCompleted()
}

/**
 * Mark messages as read
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {Array<object>} keys - Array of message keys to mark as read
 * @returns {Promise<object>} Result of the read operation
 */
const readMessage = async (session, keys) => {
    info('MessageHandler', 'Marking messages as read', {
        count: keys.length,
    })
    
    return session.readMessages(keys)
}

/**
 * Get a message from the store
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} messageId - The message ID to retrieve
 * @param {string} remoteJid - The remote JID of the chat
 * @returns {Promise<object>} The retrieved message
 */
const getStoreMessage = async (session, messageId, remoteJid) => {
    try {
        debug('MessageHandler', 'Retrieving message from store', {
            messageId,
            remoteJid,
        })
        
        return await session.store.loadMessages(remoteJid, messageId)
    } catch (err) {
        error('MessageHandler', 'Failed to retrieve message from store', {
            messageId,
            remoteJid,
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Extract media content from a message
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {object} message - The message object containing media
 * @returns {Promise<object>} Object containing media details and base64 content
 */
const getMessageMedia = async (session, message) => {
    try {
        const messageType = Object.keys(message.message)[0]
        const mediaMessage = message.message[messageType]
        
        info('MessageHandler', 'Downloading media message', {
            messageType,
            fileName: mediaMessage.fileName,
            mimetype: mediaMessage.mimetype,
        })
        
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            { reuploadRequest: session.updateMediaMessage },
        )

        const result = {
            messageType,
            fileName: mediaMessage.fileName ?? '',
            caption: mediaMessage.caption ?? '',
            size: {
                fileLength: mediaMessage.fileLength,
                height: mediaMessage.height ?? 0,
                width: mediaMessage.width ?? 0,
            },
            mimetype: mediaMessage.mimetype,
            base64: buffer.toString('base64'),
        }
        
        success('MessageHandler', 'Media downloaded successfully', {
            messageType,
            size: buffer.length,
        })
        
        return result
    } catch (err) {
        error('MessageHandler', 'Failed to download media', {
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Convert byte array to base64 string
 * 
 * @param {Uint8Array|ArrayBuffer} arrayBytes - The byte array to convert
 * @returns {string} Base64 encoded string
 */
const convertToBase64 = (arrayBytes) => {
    const byteArray = new Uint8Array(arrayBytes)
    return Buffer.from(byteArray).toString('base64')
}

/**
 * Filter messages to process only new, relevant messages
 * 
 * @param {Array<object>} messages - Array of messages to filter
 * @returns {Array<object>} Filtered array of messages
 */
const filterMessages = (messages) => {
    const now = Math.floor(Date.now() / 1000)
    
    info('MessageHandler', 'Filtering messages', {
        total: messages.length,
    })

    const filtered = messages.filter((msg) => {
        // Ignore messages from self
        if (msg.key.fromMe) {
            debug('MessageHandler', 'Skipping message from self', {
                messageId: msg.key.id,
            })
            return false
        }

        // Ignore old messages based on timestamp
        const msgTime = msg.messageTimestamp ? Number(msg.messageTimestamp) : 0

        if (now - msgTime >= 60) {
            debug('MessageHandler', 'Skipping old message', {
                messageId: msg.key.id,
                age: `${now - msgTime} seconds`,
            })
            return false
        }

        // Log incoming message with more details
        const messageType = Object.keys(msg.message || {})[0] || 'unknown'
        const isGroup = msg.key.remoteJid?.endsWith('@g.us')
        
        incoming('MessageHandler', `New ${isGroup ? 'group' : 'private'} message received`, {
            messageId: msg.key.id,
            from: msg.key.remoteJid,
            messageType,
            timestamp: msg.messageTimestamp,
            pushName: msg.pushName || 'Unknown',
        })
        
        return true
    })
    
    info('MessageHandler', 'Filtering complete', {
        total: messages.length,
        accepted: filtered.length,
        rejected: messages.length - filtered.length,
    })
    
    return filtered
}

/**
 * Process media messages for webhook by converting to base64
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {object} msg - The message object
 * @param {string} typeMessage - The type of message
 * @returns {Promise<object>} Message with converted media
 */
const processMediaForWebhook = async (session, msg, typeMessage) => {
    info('MessageHandler', 'Converting media to base64 for webhook', {
        typeMessage,
    })

    const mediaMessage = await getMessageMedia(session, msg)

    const fieldsToConvert = [
        'fileEncSha256',
        'mediaKey',
        'fileSha256',
        'jpegThumbnail',
        'thumbnailSha256',
        'thumbnailEncSha256',
        'streamingSidecar',
    ]

    fieldsToConvert.forEach((field) => {
        if (msg.message[typeMessage]?.[field] !== undefined) {
            msg.message[typeMessage][field] = convertToBase64(msg.message[typeMessage][field])
        }
    })

    success('MessageHandler', 'Media converted to base64 successfully', {
        typeMessage,
        base64Length: mediaMessage.base64.length,
    })

    return {
        ...msg,
        message: {
            [typeMessage]: {
                ...msg.message[typeMessage],
                fileBase64: mediaMessage.base64,
            },
        },
    }
}

/**
 * Auto-read messages if enabled in environment
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {Array<object>} messages - Array of messages to mark as read
 */
const autoReadMessages = async (session, messages) => {
    if (process.env.AUTO_READ_MESSAGES === 'true') {
        try {
            await session.readMessages(messages.map((msg) => msg.key))
            success('MessageHandler', 'Messages marked as read', {
                count: messages.length,
            })
        } catch (err) {
            error('MessageHandler', 'Failed to mark messages as read', {
                count: messages.length,
                error: err.message,
            })
        }
    }
}

/**
 * Update message status to human-readable format
 * 
 * @param {object} msg - The message object to update
 */
const updateMessageStatus = (msg) => {
    if (msg?.status) {
        msg.status = WAMessageStatus[msg?.status] ?? 'UNKNOWN'
    }
}

export {
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
}
