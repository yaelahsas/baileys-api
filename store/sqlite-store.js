import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { EventEmitter } from 'events'
import { jidNormalizedUser } from 'baileys'

class SQLiteStore extends EventEmitter {
    constructor(options = {}) {
        super()

        const retentionDays = Number(options.retentionDays ?? 90)
        const pruneInterval = Number(options.pruneInterval ?? 24 * 60 * 60 * 1000)
        this.config = {
            dbFile: options.dbFile || path.resolve(process.cwd(), 'sessions', 'messages.db'),
            retentionDays: Number.isFinite(retentionDays) ? retentionDays : 90,
            pruneInterval: Number.isFinite(pruneInterval) ? pruneInterval : 24 * 60 * 60 * 1000,
        }
        this.chats = new Map()
        this.contacts = new Map()
        this.groupMetadata = new Map()

        fs.mkdirSync(path.dirname(this.config.dbFile), { recursive: true })
        this.db = new Database(this.config.dbFile)
        this.db.pragma('journal_mode = WAL')
        this.db.pragma('synchronous = NORMAL')
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                jid TEXT NOT NULL,
                fromMe INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                message TEXT NOT NULL,
                indexedAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, timestamp DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_jid_id ON messages(jid, id);
        `)

        this.upsertStatement = this.db.prepare(`
            INSERT INTO messages (id, jid, fromMe, timestamp, message, indexedAt)
            VALUES (@id, @jid, @fromMe, @timestamp, @message, @indexedAt)
            ON CONFLICT(id) DO UPDATE SET
                jid = excluded.jid,
                fromMe = excluded.fromMe,
                timestamp = excluded.timestamp,
                message = excluded.message,
                indexedAt = excluded.indexedAt
        `)
        this.upsertMany = this.db.transaction((messages) => {
            for (const message of messages) this.upsertMessage(message)
        })

        this.pruneMessages()
        if (this.config.retentionDays > 0 && this.config.pruneInterval > 0) {
            this.pruneTimer = setInterval(() => this.pruneMessages(), this.config.pruneInterval)
            this.pruneTimer.unref?.()
        }
    }

    upsertMessage(msg) {
        if (!msg?.key?.id || !msg.key.remoteJid) return

        this.upsertStatement.run({
            id: msg.key.id,
            jid: jidNormalizedUser(msg.key.remoteJid),
            fromMe: msg.key.fromMe ? 1 : 0,
            timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
            message: JSON.stringify(msg),
            indexedAt: Date.now(),
        })
    }

    bind(ev) {
        ev.on('messages.upsert', ({ messages = [] }) => this.upsertMany(messages))
        ev.on('messaging-history.set', ({ messages = [], chats = [], contacts = [] }) => {
            this.upsertMany(messages)
            for (const chat of chats) this.chats.set(jidNormalizedUser(chat.id), chat)
            for (const contact of contacts) this.contacts.set(jidNormalizedUser(contact.id), contact)
        })
        ev.on('chats.upsert', (chats = []) => {
            for (const chat of chats) this.chats.set(jidNormalizedUser(chat.id), chat)
        })
        ev.on('chats.set', ({ chats = [] }) => {
            for (const chat of chats) this.chats.set(jidNormalizedUser(chat.id), chat)
        })
        ev.on('chats.delete', (jids = []) => {
            const deleteMessages = this.db.prepare('DELETE FROM messages WHERE jid = ?')
            for (const jid of jids) {
                const normalizedJid = jidNormalizedUser(jid)
                this.chats.delete(normalizedJid)
                deleteMessages.run(normalizedJid)
            }
        })
        ev.on('contacts.upsert', (contacts = []) => {
            for (const contact of contacts) this.contacts.set(jidNormalizedUser(contact.id), contact)
        })
        ev.on('groups.update', (updates = []) => {
            for (const update of updates) {
                this.groupMetadata.set(update.id, { ...(this.groupMetadata.get(update.id) || {}), ...update })
            }
        })
    }

    async loadMessages(jid, limitOrMessageId = 25, cursor = null, options = {}) {
        const normalizedJid = jidNormalizedUser(jid)

        if (typeof limitOrMessageId === 'string') {
            const row = this.db
                .prepare('SELECT message FROM messages WHERE jid = ? AND id = ?')
                .get(normalizedJid, limitOrMessageId)
            return row ? [JSON.parse(row.message)] : []
        }

        const limit = Math.max(1, Math.min(500, Number(limitOrMessageId) || 25))
        const conditions = ['jid = @jid']
        const params = { jid: normalizedJid, limit }

        if (options.from !== undefined) {
            conditions.push('timestamp >= @from')
            params.from = Number(options.from)
        }
        if (options.to !== undefined) {
            conditions.push('timestamp <= @to')
            params.to = Number(options.to)
        }

        if (cursor?.before?.id) {
            const cursorRow = this.db
                .prepare('SELECT timestamp FROM messages WHERE jid = ? AND id = ?')
                .get(normalizedJid, cursor.before.id)
            if (cursorRow) {
                conditions.push('(timestamp < @cursorTimestamp OR (timestamp = @cursorTimestamp AND id < @cursorId))')
                params.cursorTimestamp = cursorRow.timestamp
                params.cursorId = cursor.before.id
            }
        }

        const rows = this.db
            .prepare(
                `
            SELECT message FROM messages
            WHERE ${conditions.join(' AND ')}
            ORDER BY timestamp DESC, id DESC
            LIMIT @limit
        `,
            )
            .all(params)

        return rows.map((row) => JSON.parse(row.message))
    }

    pruneMessages(nowSeconds = Math.floor(Date.now() / 1000)) {
        if (this.config.retentionDays <= 0) return 0
        const cutoff = nowSeconds - this.config.retentionDays * 86400
        return this.db.prepare('DELETE FROM messages WHERE timestamp < ?').run(cutoff).changes
    }

    readFromFile(file) {
        if (!file || !fs.existsSync(file)) return
        if (this.db.pragma('user_version', { simple: true }) > 0) return

        const count = this.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count
        if (count > 0) return

        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'))
            const messages = Object.values(data.messages || {}).flatMap((entries) =>
                entries.map(([, message]) => message),
            )
            this.upsertMany(messages)
            this.pruneMessages()
            this.db.pragma('user_version = 1')
        } catch (error) {
            console.error('Failed to migrate memory store to SQLite:', error.message)
        }
    }

    writeToFile() {
        this.db.pragma('wal_checkpoint(PASSIVE)')
    }

    getContactList(type = 'all') {
        return Array.from(this.contacts.values())
            .filter((contact) => contact?.id?.endsWith('@s.whatsapp.net') && (type !== 'saved' || contact.name))
            .map((contact) => contact.id)
    }

    cleanup() {
        if (this.pruneTimer) clearInterval(this.pruneTimer)
        if (this.db?.open) this.db.close()
        this.removeAllListeners()
    }
}

const makeSQLiteStore = (options = {}) => new SQLiteStore(options)

export default makeSQLiteStore
export { SQLiteStore }
