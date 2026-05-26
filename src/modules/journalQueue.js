/**
 * Journal Queue Module
 *
 * Persistent queue system for journal submissions using SQLite.
 * Ensures no journal data is lost even when:
 * - The API server is temporarily down
 * - The WhatsApp bot disconnects and reconnects
 * - The bot process restarts
 *
 * Features:
 * - Persistent storage (SQLite) - survives restarts
 * - Status tracking: pending → processing → sent / failed
 * - Deduplication by WhatsApp message ID
 * - Automatic retry of pending entries on connection open
 * - Periodic retry of stuck pending entries
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import axios from 'axios'
import {
    info,
    success,
    error,
    warning,
    debug,
    queue as queueLog,
} from '../utils/logger.js'

/**
 * Journal status enum
 */
const JournalStatus = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    SENT: 'sent',
    FAILED: 'failed',
}

/**
 * API configuration (shared with commandHandler)
 */
const API_CONFIG = {
    base_url: process.env.API_BASE_URL || 'http://sim-mtsn.test/api',
    api_key: process.env.API_KEY || 'whatsapp_bot_key_2024',
    timeout: parseInt(process.env.API_TIMEOUT) || 30000,
    max_retries: parseInt(process.env.API_MAX_RETRIES) || 3,
    retry_delay: parseInt(process.env.API_RETRY_DELAY) || 2000,
}

/**
 * JournalQueue - Persistent journal submission queue
 */
class JournalQueue {
    constructor() {
        this.db = null
        this.dbPath = null
        this.isProcessing = false
        this.periodicTimer = null
        this.periodicInterval = 60000 // Check every 60 seconds for stuck pending entries
        this.sendMessageCallback = null // Callback to send WhatsApp messages
    }

    /**
     * Initialize the SQLite database
     * @param {string} dbDir - Directory to store the database file
     */
    init(dbDir = null) {
        const dir = dbDir || path.join(process.cwd(), 'data')

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }

        this.dbPath = path.join(dir, 'journal_queue.db')
        this.db = new Database(this.dbPath)

        // Enable WAL mode for better concurrent performance
        this.db.pragma('journal_mode = WAL')

        // Create table if not exists
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS journal_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT UNIQUE,
                session_id TEXT NOT NULL,
                group_jid TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                no_lid TEXT NOT NULL,
                kelas TEXT DEFAULT '',
                materi TEXT NOT NULL,
                tanggal TEXT NOT NULL,
                metode TEXT DEFAULT 'luring',
                jenis TEXT DEFAULT 'akademik',
                foto TEXT NOT NULL,
                keterangan TEXT DEFAULT 'Jurnal via WhatsApp Bot',
                attempts INTEGER DEFAULT 0,
                max_attempts INTEGER DEFAULT 3,
                last_error TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                sent_at INTEGER DEFAULT NULL
            )
        `)

        // Create index for faster pending queries
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_journal_queue_status ON journal_queue(status)
        `)
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_journal_queue_session_status ON journal_queue(session_id, status)
        `)
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_journal_queue_message_id ON journal_queue(message_id)
        `)

        info('JournalQueue', 'Database initialized', {
            dbPath: this.dbPath,
        })

        // Start periodic check for stuck pending entries
        this.startPeriodicCheck()

        return this
    }

    /**
     * Set callback for sending WhatsApp messages (used to notify users of delayed submissions)
     * @param {Function} callback - Function(sessionId, groupJid, message, options)
     */
    setSendMessageCallback(callback) {
        this.sendMessageCallback = callback
        debug('JournalQueue', 'Send message callback set')
    }

    /**
     * Add a journal entry to the queue
     * Returns the entry status if it already exists (deduplication)
     *
     * @param {object} data - Journal data
     * @param {string} data.messageId - WhatsApp message key ID (for deduplication)
     * @param {string} data.sessionId - Session ID
     * @param {string} data.groupJid - Group JID
     * @param {string} data.no_lid - Teacher phone number/LID
     * @param {string} data.kelas - Class name
     * @param {string} data.materi - Subject/material
     * @param {string} data.tanggal - Date YYYY-MM-DD
     * @param {string} data.metode - luring or daring
     * @param {string} data.jenis - akademik or non_akademik
     * @param {string} data.foto - Base64 image data (data:mimetype;base64,...)
     * @param {string} data.keterangan - Note
     * @returns {object} { id, status, isNew } - Entry info after insertion
     */
    enqueue(data) {
        const now = Date.now()

        // Check if message already exists (deduplication)
        const existing = this.db.prepare(
            'SELECT id, status, attempts FROM journal_queue WHERE message_id = ?'
        ).get(data.messageId)

        if (existing) {
            // Message already in queue
            if (existing.status === JournalStatus.SENT) {
                queueLog('JournalQueue', 'Message already sent, skipping', {
                    messageId: data.messageId,
                    id: existing.id,
                })
                return { id: existing.id, status: existing.status, isNew: false }
            }

            if (existing.status === JournalStatus.PROCESSING) {
                queueLog('JournalQueue', 'Message is currently being processed, skipping', {
                    messageId: data.messageId,
                    id: existing.id,
                })
                return { id: existing.id, status: existing.status, isNew: false }
            }

            // If pending or failed, update with fresh data (in case image was re-sent)
            this.db.prepare(`
                UPDATE journal_queue SET
                    no_lid = ?, kelas = ?, materi = ?, tanggal = ?,
                    metode = ?, jenis = ?, foto = ?, keterangan = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(
                data.no_lid, data.kelas, data.materi, data.tanggal,
                data.metode, data.jenis, data.foto, data.keterangan,
                now, existing.id
            )

            queueLog('JournalQueue', 'Existing entry updated with fresh data', {
                messageId: data.messageId,
                id: existing.id,
                previousStatus: existing.status,
            })

            return { id: existing.id, status: existing.status, isNew: false }
        }

        // Insert new entry
        const result = this.db.prepare(`
            INSERT INTO journal_queue (
                message_id, session_id, group_jid, status,
                no_lid, kelas, materi, tanggal, metode, jenis, foto, keterangan,
                attempts, max_attempts, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
        `).run(
            data.messageId, data.sessionId, data.groupJid, JournalStatus.PENDING,
            data.no_lid, data.kelas, data.materi, data.tanggal,
            data.metode, data.jenis, data.foto, data.keterangan,
            0, 3, now, now
        )

        queueLog('JournalQueue', 'Journal entry added to queue', {
            messageId: data.messageId,
            id: result.lastInsertRowid,
            no_lid: data.no_lid,
            kelas: data.kelas,
            materi: data.materi,
        })

        return { id: result.lastInsertRowid, status: JournalStatus.PENDING, isNew: true }
    }

    /**
     * Update the status of a journal entry
     *
     * @param {number} id - Database row ID
     * @param {string} status - New status
     * @param {object} extras - Additional data to update
     */
    updateStatus(id, status, extras = {}) {
        const now = Date.now()

        const fields = ['status = ?', 'updated_at = ?']
        const values = [status, now]

        if (status === JournalStatus.SENT) {
            fields.push('sent_at = ?')
            values.push(now)
        }

        if (extras.lastError) {
            fields.push('last_error = ?')
            values.push(extras.lastError)
        }

        if (extras.attempts !== undefined) {
            fields.push('attempts = ?')
            values.push(extras.attempts)
        }

        this.db.prepare(
            `UPDATE journal_queue SET ${fields.join(', ')} WHERE id = ?`
        ).run(...values, id)

        queueLog('JournalQueue', 'Status updated', {
            id,
            status,
            ...extras,
        })
    }

    /**
     * Check if a message has already been processed (sent)
     * Used for deduplication in the message handler
     *
     * @param {string} messageId - WhatsApp message key ID
     * @returns {object|null} { id, status } or null if not found
     */
    checkMessage(messageId) {
        const row = this.db.prepare(
            'SELECT id, status FROM journal_queue WHERE message_id = ?'
        ).get(messageId)

        return row || null
    }

    /**
     * Get all pending entries for a session
     *
     * @param {string} sessionId - Session ID to filter by
     * @returns {Array} Array of pending entries
     */
    getPendingBySession(sessionId) {
        return this.db.prepare(
            'SELECT * FROM journal_queue WHERE session_id = ? AND status = ? ORDER BY created_at ASC'
        ).all(sessionId, JournalStatus.PENDING)
    }

    /**
     * Get all pending entries across all sessions
     *
     * @returns {Array} Array of pending entries
     */
    getAllPending() {
        return this.db.prepare(
            'SELECT * FROM journal_queue WHERE status = ? ORDER BY created_at ASC'
        ).all(JournalStatus.PENDING)
    }

    /**
     * Get failed entries that can be retried (attempts < max_attempts)
     *
     * @param {string} sessionId - Optional session ID filter
     * @returns {Array} Array of retryable failed entries
     */
    getRetryable(sessionId = null) {
        if (sessionId) {
            return this.db.prepare(
                'SELECT * FROM journal_queue WHERE session_id = ? AND status = ? AND attempts < max_attempts ORDER BY created_at ASC'
            ).all(sessionId, JournalStatus.FAILED)
        }
        return this.db.prepare(
            'SELECT * FROM journal_queue WHERE status = ? AND attempts < max_attempts ORDER BY created_at ASC'
        ).all(JournalStatus.FAILED)
    }

    /**
     * Process a single journal entry - send to API
     *
     * @param {object} entry - Database entry
     * @returns {Promise<boolean>} True if sent successfully
     */
    async processEntry(entry) {
        // Mark as processing
        this.updateStatus(entry.id, JournalStatus.PROCESSING)

        try {
            const data = {
                no_lid: entry.no_lid,
                kelas: entry.kelas,
                materi: entry.materi,
                keterangan: entry.keterangan,
                foto: entry.foto,
                tanggal: entry.tanggal,
                metode: entry.metode,
                jenis: entry.jenis,
            }

            const response = await axios.post(`${API_CONFIG.base_url}/create_jurnal`, data, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': API_CONFIG.api_key,
                },
                timeout: API_CONFIG.timeout,
            })

            if (response.data && response.data.status === 'success') {
                // Mark as sent
                this.updateStatus(entry.id, JournalStatus.SENT)

                const jurnalData = response.data.data.jurnal_data

                success('JournalQueue', 'Delayed journal sent successfully', {
                    id: entry.id,
                    messageId: entry.message_id,
                    no_lid: entry.no_lid,
                    kelas: entry.kelas,
                    materi: entry.materi,
                })

                // Notify the group that the delayed submission was successful
                if (this.sendMessageCallback) {
                    const successMessage =
                        `✅ Jurnal berhasil disimpan (dikirim dari antrian)\n\n` +
                        `👨‍🏫 Guru   : ${jurnalData.nama_guru}\n` +
                        (entry.kelas ? `🏫 Kelas  : ${entry.kelas}\n` : '') +
                        `📚 Materi : ${entry.materi}\n` +
                        `📅 Tgl    : ${jurnalData.tanggal}\n` +
                        `💻 Metode : ${entry.metode === 'daring' ? 'Daring' : 'Luring'}\n` +
                        `📋 Jenis  : ${entry.jenis === 'non_akademik' ? 'Non-Akademik' : 'Akademik'}\n` +
                        `🔄 Dikirim dari antrian (sebelumnya gagal/disimpan)`

                    try {
                        await this.sendMessageCallback(entry.session_id, entry.group_jid, { text: successMessage })
                    } catch (sendErr) {
                        warning('JournalQueue', 'Failed to send success notification to group', {
                            error: sendErr.message,
                        })
                    }
                }

                return true
            } else {
                // API returned but not success
                const errorMsg = response.data?.message || 'API returned non-success status'
                const newAttempts = entry.attempts + 1

                if (newAttempts >= entry.max_attempts) {
                    this.updateStatus(entry.id, JournalStatus.FAILED, {
                        lastError: errorMsg,
                        attempts: newAttempts,
                    })
                } else {
                    this.updateStatus(entry.id, JournalStatus.PENDING, {
                        lastError: errorMsg,
                        attempts: newAttempts,
                    })
                }

                error('JournalQueue', 'API returned non-success', {
                    id: entry.id,
                    messageId: entry.message_id,
                    attempts: newAttempts,
                    error: errorMsg,
                })

                return false
            }
        } catch (err) {
            const newAttempts = entry.attempts + 1
            const errorMsg = err.response?.data?.message || err.message || 'Unknown error'

            if (newAttempts >= entry.max_attempts) {
                this.updateStatus(entry.id, JournalStatus.FAILED, {
                    lastError: errorMsg,
                    attempts: newAttempts,
                })
            } else {
                this.updateStatus(entry.id, JournalStatus.PENDING, {
                    lastError: errorMsg,
                    attempts: newAttempts,
                })
            }

            error('JournalQueue', 'Failed to send journal to API', {
                id: entry.id,
                messageId: entry.message_id,
                attempts: newAttempts,
                maxAttempts: entry.max_attempts,
                error: errorMsg,
            })

            return false
        }
    }

    /**
     * Process all pending and retryable entries for a session
     * Called when bot reconnects (connection open)
     *
     * @param {string} sessionId - Session ID
     * @returns {Promise<object>} Processing results { processed, sent, failed }
     */
    async processPendingBySession(sessionId) {
        if (this.isProcessing) {
            debug('JournalQueue', 'Already processing, skipping', { sessionId })
            return { processed: 0, sent: 0, failed: 0 }
        }

        this.isProcessing = true

        try {
            // Get pending entries
            const pendingEntries = this.getPendingBySession(sessionId)
            // Get retryable failed entries
            const failedEntries = this.getRetryable(sessionId)

            const allEntries = [...pendingEntries, ...failedEntries]

            if (allEntries.length === 0) {
                debug('JournalQueue', 'No pending entries to process', { sessionId })
                return { processed: 0, sent: 0, failed: 0 }
            }

            info('JournalQueue', 'Processing pending journal entries', {
                sessionId,
                pendingCount: pendingEntries.length,
                failedRetryCount: failedEntries.length,
                total: allEntries.length,
            })

            let sentCount = 0
            let failedCount = 0

            for (const entry of allEntries) {
                const result = await this.processEntry(entry)
                if (result) {
                    sentCount++
                } else {
                    failedCount++
                }

                // Small delay between processing entries to avoid overwhelming API
                await new Promise(resolve => setTimeout(resolve, 1000))
            }

            success('JournalQueue', 'Batch processing completed', {
                sessionId,
                processed: allEntries.length,
                sent: sentCount,
                failed: failedCount,
            })

            return { processed: allEntries.length, sent: sentCount, failed: failedCount }
        } finally {
            this.isProcessing = false
        }
    }

    /**
     * Process all pending entries across all sessions
     * Used for periodic checks
     *
     * @returns {Promise<object>} Processing results
     */
    async processAllPending() {
        if (this.isProcessing) {
            return { processed: 0, sent: 0, failed: 0 }
        }

        this.isProcessing = true

        try {
            const pendingEntries = this.getAllPending()
            const failedEntries = this.getRetryable()

            const allEntries = [...pendingEntries, ...failedEntries]

            if (allEntries.length === 0) {
                return { processed: 0, sent: 0, failed: 0 }
            }

            info('JournalQueue', 'Periodic processing of pending entries', {
                total: allEntries.length,
            })

            let sentCount = 0
            let failedCount = 0

            for (const entry of allEntries) {
                // Check if session exists and is connected before processing
                const sessionManager = await import('./sessionManager.js')
                const wa = sessionManager.getSession(entry.session_id)
                if (!wa || wa.ws?.socket?.readyState !== 1) {
                    debug('JournalQueue', 'Session not connected, skipping entry', {
                        sessionId: entry.session_id,
                        entryId: entry.id,
                    })
                    continue
                }

                const result = await this.processEntry(entry)
                if (result) {
                    sentCount++
                } else {
                    failedCount++
                }

                await new Promise(resolve => setTimeout(resolve, 1000))
            }

            if (sentCount > 0 || failedCount > 0) {
                success('JournalQueue', 'Periodic batch processing completed', {
                    processed: allEntries.length,
                    sent: sentCount,
                    failed: failedCount,
                })
            }

            return { processed: allEntries.length, sent: sentCount, failed: failedCount }
        } finally {
            this.isProcessing = false
        }
    }

    /**
     * Start periodic check for stuck pending entries
     * Runs every 60 seconds to retry entries that might have been missed
     */
    startPeriodicCheck() {
        if (this.periodicTimer) {
            clearInterval(this.periodicTimer)
        }

        this.periodicTimer = setInterval(() => {
            this.processAllPending().catch(err => {
                error('JournalQueue', 'Periodic processing error', {
                    error: err.message,
                })
            })
        }, this.periodicInterval)

        info('JournalQueue', 'Periodic check started', {
            interval: this.periodicInterval,
        })
    }

    /**
     * Stop periodic check
     */
    stopPeriodicCheck() {
        if (this.periodicTimer) {
            clearInterval(this.periodicTimer)
            this.periodicTimer = null
            info('JournalQueue', 'Periodic check stopped')
        }
    }

    /**
     * Get queue statistics
     *
     * @returns {object} Queue stats
     */
    getStats() {
        const stats = this.db.prepare(`
            SELECT status, COUNT(*) as count FROM journal_queue GROUP BY status
        `).all()

        const result = {
            pending: 0,
            processing: 0,
            sent: 0,
            failed: 0,
            total: 0,
        }

        for (const row of stats) {
            result[row.status] = row.count
            result.total += row.count
        }

        return result
    }

    /**
     * Get entries by status
     *
     * @param {string} status - Status to filter by
     * @param {number} limit - Maximum entries to return
     * @returns {Array} Array of entries
     */
    getByStatus(status, limit = 50) {
        return this.db.prepare(
            'SELECT id, message_id, session_id, group_jid, no_lid, kelas, materi, tanggal, status, attempts, created_at, updated_at FROM journal_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?'
        ).all(status, limit)
    }

    /**
     * Clean up old sent/failed entries (older than specified days)
     *
     * @param {number} days - Number of days to keep (default 30)
     * @returns {number} Number of entries cleaned
     */
    cleanup(days = 30) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000)
        const result = this.db.prepare(
            'DELETE FROM journal_queue WHERE (status = ? OR status = ?) AND updated_at < ?'
        ).run(JournalStatus.SENT, JournalStatus.FAILED, cutoff)

        if (result.changes > 0) {
            info('JournalQueue', 'Old entries cleaned up', {
                days,
                entriesRemoved: result.changes,
            })
        }

        return result.changes
    }

    /**
     * Close the database connection
     */
    close() {
        this.stopPeriodicCheck()
        if (this.db) {
            this.db.close()
            info('JournalQueue', 'Database connection closed')
        }
    }
}

// Create singleton instance
const journalQueue = new JournalQueue()

export {
    JournalQueue,
    JournalStatus,
    journalQueue,
}
