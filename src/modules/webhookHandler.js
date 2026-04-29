/**
 * Webhook Handler Module
 *
 * This module handles all webhook-related operations including:
 * - Sending webhook notifications
 * - Filtering webhook events
 * - Managing webhook event types
 */

import axios from 'axios'
import {
    info,
    success,
    error,
    warning,
    webhook as webhookLog,
    debug,
} from '../utils/logger.js'

/**
 * Allowed webhook events from environment
 * @type {Array<string>}
 */
const APP_WEBHOOK_ALLOWED_EVENTS = process.env.APP_WEBHOOK_ALLOWED_EVENTS
    ? process.env.APP_WEBHOOK_ALLOWED_EVENTS.split(',')
    : []

/**
 * Send webhook notification
 * 
 * @param {string} instance - The session/instance ID
 * @param {string} type - The event type
 * @param {object} data - The event data
 * @returns {Promise<object>} Response from webhook or error
 */
const webhook = async (instance, type, data) => {
    if (process.env.APP_WEBHOOK_URL) {
        const webhookUrl = process.env.APP_WEBHOOK_URL
        
        webhookLog('WebhookHandler', 'Sending webhook notification', {
            instance,
            type,
            url: webhookUrl,
            dataSize: JSON.stringify(data).length,
        })
        
        return axios
            .post(webhookUrl, {
                instance,
                type,
                data,
            })
            .then((response) => {
                success('WebhookHandler', 'Webhook sent successfully', {
                    instance,
                    type,
                    status: response.status,
                })
                return response
            })
            .catch((err) => {
                error('WebhookHandler', 'Webhook send failed', {
                    instance,
                    type,
                    error: err.message,
                    status: err.response?.status,
                })
                return err
            })
    } else {
        debug('WebhookHandler', 'Webhook URL not configured, skipping')
    }
}

/**
 * Call webhook if event type is allowed
 * 
 * @param {string} instance - The session/instance ID
 * @param {string} eventType - The event type to check
 * @param {object} eventData - The event data to send
 * @returns {Promise<void>}
 */
const callWebhook = async (instance, eventType, eventData) => {
    if (APP_WEBHOOK_ALLOWED_EVENTS.includes('ALL') || APP_WEBHOOK_ALLOWED_EVENTS.includes(eventType)) {
        debug('WebhookHandler', 'Calling webhook for event', {
            instance,
            eventType,
            allowedEvents: APP_WEBHOOK_ALLOWED_EVENTS,
        })
        await webhook(instance, eventType, eventData)
    } else {
        debug('WebhookHandler', 'Event type not allowed for webhook', {
            instance,
            eventType,
            allowedEvents: APP_WEBHOOK_ALLOWED_EVENTS,
        })
    }
}

/**
 * Setup all event listeners for a WhatsApp session
 * 
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {string} sessionId - The session ID
 * @param {Function} onWebhook - Callback function for webhook events
 */
const setupEventListeners = (wa, sessionId, onWebhook) => {
    info('WebhookHandler', 'Setting up event listeners', {
        sessionId,
        allowedEvents: APP_WEBHOOK_ALLOWED_EVENTS,
    })
    
    // Chat events
    wa.ev.on('chats.set', ({ chats }) => {
        debug('WebhookHandler', 'Event: chats.set', { count: chats.length })
        onWebhook(sessionId, 'CHATS_SET', chats)
    })

    wa.ev.on('chats.upsert', (c) => {
        debug('WebhookHandler', 'Event: chats.upsert', { count: c.length })
        onWebhook(sessionId, 'CHATS_UPSERT', c)
    })

    wa.ev.on('chats.delete', (c) => {
        debug('WebhookHandler', 'Event: chats.delete', { count: c.length })
        onWebhook(sessionId, 'CHATS_DELETE', c)
    })

    wa.ev.on('chats.update', (c) => {
        debug('WebhookHandler', 'Event: chats.update', { count: c.length })
        onWebhook(sessionId, 'CHATS_UPDATE', c)
    })

    // Label events
    wa.ev.on('labels.association', (l) => {
        debug('WebhookHandler', 'Event: labels.association')
        onWebhook(sessionId, 'LABELS_ASSOCIATION', l)
    })

    wa.ev.on('labels.edit', (l) => {
        debug('WebhookHandler', 'Event: labels.edit')
        onWebhook(sessionId, 'LABELS_EDIT', l)
    })

    // Message events
    wa.ev.on('messages.delete', async (m) => {
        debug('WebhookHandler', 'Event: messages.delete', { count: m.length })
        onWebhook(sessionId, 'MESSAGES_DELETE', m)
    })

    wa.ev.on('messages.update', async (m) => {
        debug('WebhookHandler', 'Event: messages.update', { count: m.length })
        onWebhook(sessionId, 'MESSAGES_UPDATE', m)
    })

    wa.ev.on('message-receipt.update', async (m) => {
        debug('WebhookHandler', 'Event: message-receipt.update', { count: m.length })
        onWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', m)
    })

    wa.ev.on('messages.reaction', async (m) => {
        debug('WebhookHandler', 'Event: messages.reaction', { count: m.length })
        onWebhook(sessionId, 'MESSAGES_REACTION', m)
    })

    wa.ev.on('messages.media-update', async (m) => {
        debug('WebhookHandler', 'Event: messages.media-update', { count: m.length })
        onWebhook(sessionId, 'MESSAGES_MEDIA_UPDATE', m)
    })

    wa.ev.on('messaging-history.set', async (m) => {
        debug('WebhookHandler', 'Event: messaging-history.set')
        onWebhook(sessionId, 'MESSAGING_HISTORY_SET', m)
    })

    // Group events
    wa.ev.on('groups.upsert', async (m) => {
        debug('WebhookHandler', 'Event: groups.upsert', { count: m.length })
        onWebhook(sessionId, 'GROUPS_UPSERT', m)
    })

    wa.ev.on('groups.update', async (m) => {
        debug('WebhookHandler', 'Event: groups.update', { count: m.length })
        onWebhook(sessionId, 'GROUPS_UPDATE', m)
    })

    wa.ev.on('group-participants.update', async (m) => {
        debug('WebhookHandler', 'Event: group-participants.update')
        onWebhook(sessionId, 'GROUP_PARTICIPANTS_UPDATE', m)
    })

    // Blocklist events
    wa.ev.on('blocklist.set', async (m) => {
        debug('WebhookHandler', 'Event: blocklist.set')
        onWebhook(sessionId, 'BLOCKLIST_SET', m)
    })

    wa.ev.on('blocklist.update', async (m) => {
        debug('WebhookHandler', 'Event: blocklist.update')
        onWebhook(sessionId, 'BLOCKLIST_UPDATE', m)
    })

    // Contact events
    wa.ev.on('contacts.set', (c) => {
        debug('WebhookHandler', 'Event: contacts.set', { count: c.length })
        onWebhook(sessionId, 'CONTACTS_SET', c)
    })

    wa.ev.on('contacts.upsert', (c) => {
        debug('WebhookHandler', 'Event: contacts.upsert', { count: c.length })
        onWebhook(sessionId, 'CONTACTS_UPSERT', c)
    })

    wa.ev.on('contacts.update', (c) => {
        debug('WebhookHandler', 'Event: contacts.update', { count: c.length })
        onWebhook(sessionId, 'CONTACTS_UPDATE', c)
    })

    // Presence events
    wa.ev.on('presence.update', async (p) => {
        debug('WebhookHandler', 'Event: presence.update')
        onWebhook(sessionId, 'PRESENCE_UPDATE', p)
    })
    
    success('WebhookHandler', 'Event listeners setup complete', {
        sessionId,
        totalListeners: 23,
    })
}

export {
    webhook,
    callWebhook,
    setupEventListeners,
}
