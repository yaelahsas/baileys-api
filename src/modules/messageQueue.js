/**
 * Message Queue Module
 *
 * This module handles message queuing to ensure all messages are sent properly
 * even when multiple requests come in simultaneously. It provides:
 * - Queue management for concurrent requests
 * - Status tracking for each message
 * - Retry mechanism for failed messages
 * - Concurrent request handling with proper synchronization
 */

import { delay } from 'baileys'
import {
    info,
    success,
    error,
    warning,
    queue,
    debug,
} from '../utils/logger.js'

/**
 * Message status enum
 */
const MessageStatus = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SENT: 'sent',
    FAILED: 'failed',
    RETRYING: 'retrying'
}

/**
 * Message queue item structure
 */
class QueueItem {
    constructor(id, session, receiver, message, options = {}, delayMs = 1000) {
        this.id = id
        this.session = session
        this.receiver = receiver
        this.message = message
        this.options = options
        this.delayMs = delayMs
        this.status = MessageStatus.PENDING
        this.attempts = 0
        this.maxAttempts = 3
        this.createdAt = Date.now()
        this.updatedAt = Date.now()
        this.error = null
        this.result = null
    }

    updateStatus(status, error = null, result = null) {
        this.status = status
        this.updatedAt = Date.now()
        if (error) this.error = error
        if (result) this.result = result
    }
}

/**
 * Message Queue Manager
 */
class MessageQueue {
    constructor() {
        this.queue = new Map() // Map<id, QueueItem>
        this.processing = new Map() // Map<id, QueueItem>
        this.completed = new Map() // Map<id, QueueItem>
        this.isProcessing = false
        this.concurrencyLimit = 5 // Maximum concurrent messages
        this.currentProcessing = 0
        this.processInterval = 100 // Check queue every 100ms
        this.processTimer = null
    }

    /**
     * Generate unique queue item ID
     */
    generateId() {
        return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    /**
     * Add a message to the queue
     */
    enqueue(session, receiver, message, options = {}, delayMs = 1000) {
        const id = this.generateId()
        const messageType = Object.keys(message)[0] || 'unknown'
        const queueItem = new QueueItem(id, session, receiver, message, options, delayMs)
        this.queue.set(id, queueItem)
        
        queue('MessageQueue', 'Message added to queue', {
            queueId: id,
            receiver,
            messageType,
            delayMs,
            queueSize: this.queue.size,
            processing: this.processing.size,
            completed: this.completed.size,
        })
        
        // Start processing if not already running
        if (!this.isProcessing) {
            this.startProcessing()
        }
        
        return id
    }

    /**
     * Start processing the queue
     */
    startProcessing() {
        if (this.isProcessing) return
        
        this.isProcessing = true
        queue('MessageQueue', 'Starting queue processor', {
            interval: this.processInterval,
            concurrencyLimit: this.concurrencyLimit,
        })
        
        this.processTimer = setInterval(() => {
            this.processQueue()
        }, this.processInterval)
    }

    /**
     * Stop processing the queue
     */
    stopProcessing() {
        if (this.processTimer) {
            clearInterval(this.processTimer)
            this.processTimer = null
        }
        this.isProcessing = false
        queue('MessageQueue', 'Stopped queue processor', {
            pending: this.queue.size,
            processing: this.processing.size,
        })
    }

    /**
     * Process the queue
     */
    async processQueue() {
        // Check if we can process more items
        if (this.currentProcessing >= this.concurrencyLimit || this.queue.size === 0) {
            return
        }

        // Get next item from queue
        const [id, queueItem] = this.queue.entries().next().value
        if (!queueItem) return

        // Move to processing
        this.queue.delete(id)
        this.processing.set(id, queueItem)
        this.currentProcessing++
        
        queue('MessageQueue', 'Processing message', {
            queueId: id,
            receiver: queueItem.receiver,
            attempt: queueItem.attempts + 1,
            currentProcessing: this.currentProcessing,
            pending: this.queue.size,
        })
        
        // Process the message
        this.processMessage(queueItem)
    }

    /**
     * Process a single message
     */
    async processMessage(queueItem) {
        queueItem.updateStatus(MessageStatus.PROCESSING)
        
        try {
            // Apply delay if specified
            if (queueItem.delayMs > 0) {
                debug('MessageQueue', 'Applying delay before sending', {
                    queueId: queueItem.id,
                    delayMs: queueItem.delayMs,
                })
                await delay(queueItem.delayMs)
            }
            
            // Send the message
            const result = await queueItem.session.sendMessage(
                queueItem.receiver,
                queueItem.message,
                queueItem.options
            )
            
            // Mark as sent
            queueItem.updateStatus(MessageStatus.SENT, null, result)
            success('MessageQueue', 'Message sent successfully', {
                queueId: queueItem.id,
                receiver: queueItem.receiver,
                attempts: queueItem.attempts + 1,
            })
            
        } catch (err) {
            error('MessageQueue', 'Error sending message', {
                queueId: queueItem.id,
                receiver: queueItem.receiver,
                error: err.message,
            })
            
            // Check if we should retry
            if (queueItem.attempts < queueItem.maxAttempts) {
                queueItem.attempts++
                queueItem.updateStatus(MessageStatus.RETRYING, err)
                
                // Add back to queue with exponential backoff
                const backoffDelay = Math.min(1000 * Math.pow(2, queueItem.attempts), 10000)
                queueItem.delayMs = backoffDelay
                this.queue.set(queueItem.id, queueItem)
                
                warning('MessageQueue', 'Message queued for retry', {
                    queueId: queueItem.id,
                    attempt: queueItem.attempts,
                    maxAttempts: queueItem.maxAttempts,
                    backoffDelay,
                })
                
            } else {
                // Mark as failed
                queueItem.updateStatus(MessageStatus.FAILED, err)
                error('MessageQueue', 'Message failed after max attempts', {
                    queueId: queueItem.id,
                    receiver: queueItem.receiver,
                    maxAttempts: queueItem.maxAttempts,
                    error: err.message,
                })
            }
        } finally {
            // Move from processing to completed or back to queue
            if (queueItem.status === MessageStatus.SENT || queueItem.status === MessageStatus.FAILED) {
                this.processing.delete(queueItem.id)
                this.completed.set(queueItem.id, queueItem)
            } else if (queueItem.status === MessageStatus.RETRYING) {
                this.processing.delete(queueItem.id)
            }
            
            this.currentProcessing--
            
            // Clean up old completed items (older than 1 hour)
            this.cleanupCompleted()
        }
    }

    /**
     * Clean up old completed items
     */
    cleanupCompleted() {
        const oneHourAgo = Date.now() - (60 * 60 * 1000)
        let cleanedCount = 0
        
        for (const [id, item] of this.completed.entries()) {
            if (item.updatedAt < oneHourAgo) {
                this.completed.delete(id)
                cleanedCount++
                debug('MessageQueue', 'Cleaned up old completed item', {
                    queueId: id,
                    age: `${Math.floor((Date.now() - item.updatedAt) / 1000)}s`,
                })
            }
        }
        
        if (cleanedCount > 0) {
            info('MessageQueue', 'Cleanup completed', {
                itemsCleaned: cleanedCount,
                remainingCompleted: this.completed.size,
            })
        }
    }

    /**
     * Get status of a message
     */
    getStatus(id) {
        if (this.queue.has(id)) {
            debug('MessageQueue', 'Retrieved queue item status', {
                queueId: id,
                status: 'pending',
            })
            return { ...this.queue.get(id) }
        }
        if (this.processing.has(id)) {
            debug('MessageQueue', 'Retrieved queue item status', {
                queueId: id,
                status: 'processing',
            })
            return { ...this.processing.get(id) }
        }
        if (this.completed.has(id)) {
            debug('MessageQueue', 'Retrieved queue item status', {
                queueId: id,
                status: this.completed.get(id).status,
            })
            return { ...this.completed.get(id) }
        }
        warning('MessageQueue', 'Queue item not found', {
            queueId: id,
        })
        return null
    }

    /**
     * Get queue statistics
     */
    getStats() {
        const stats = {
            pending: this.queue.size,
            processing: this.processing.size,
            completed: this.completed.size,
            currentProcessing: this.currentProcessing,
            isProcessing: this.isProcessing
        }
        
        debug('MessageQueue', 'Retrieved queue statistics', stats)
        
        return stats
    }

    /**
     * Clear all completed items
     */
    clearCompleted() {
        const count = this.completed.size
        this.completed.clear()
        queue('MessageQueue', 'Cleared completed items', {
            count,
        })
        return count
    }

    /**
     * Get all items with a specific status
     */
    getItemsByStatus(status) {
        const items = []
        
        if (status === MessageStatus.PENDING) {
            for (const [id, item] of this.queue.entries()) {
                items.push({ ...item })
            }
        } else if (status === MessageStatus.PROCESSING) {
            for (const [id, item] of this.processing.entries()) {
                items.push({ ...item })
            }
        } else if (status === MessageStatus.SENT || status === MessageStatus.FAILED) {
            for (const [id, item] of this.completed.entries()) {
                if (item.status === status) {
                    items.push({ ...item })
                }
            }
        }
        
        return items
    }
}

// Create singleton instance
const messageQueue = new MessageQueue()

export {
    MessageQueue,
    QueueItem,
    MessageStatus,
    messageQueue
}
