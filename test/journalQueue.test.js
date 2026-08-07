import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import axios from 'axios'

import { JournalQueue } from '../src/modules/journalQueue.js'

/**
 * Create an isolated JournalQueue on a fresh temp dir. The `fn` body runs and
 * the queue is always closed + temp dir removed afterward (finally), so the
 * periodic-check interval never keeps the test process alive.
 */
function rmForce(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
        // Windows can briefly hold SQLite WAL handles after close()
        if (err.code !== 'EPERM') throw err
    }
}

async function withQueue(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqtest-'))
    const q = new JournalQueue()
    q.init(dir)
    try {
        await fn(q)
    } finally {
        q.close()
        rmForce(dir)
    }
}

function baseEntry(overrides = {}) {
    return {
        messageId: 'msg1',
        sessionId: 'sess1',
        groupJid: 'group1@g.us',
        no_lid: '628123',
        kelas: '7A',
        materi: 'Matematika',
        tanggal: '2024-01-15',
        metode: 'luring',
        jenis: 'akademik',
        foto: 'data:image/png;base64,abc',
        keterangan: 'Jurnal via WhatsApp Bot',
        ...overrides,
    }
}

test('fresh DB: composite unique index enforces dedup by (session, group, message)', async () => {
    await withQueue(async (q) => {
        const a = q.enqueue(baseEntry({ messageId: 'm1' }))
        const b = q.enqueue(baseEntry({ messageId: 'm1' }))

        assert.equal(a.isNew, true)
        assert.equal(b.isNew, false)
        assert.equal(a.id, b.id)

        // Different session -> separate row
        const c = q.enqueue(baseEntry({ messageId: 'm1', sessionId: 'sess2' }))
        assert.equal(c.isNew, true)
        assert.notEqual(c.id, a.id)

        // Different group -> separate row
        const d = q.enqueue(baseEntry({ messageId: 'm1', groupJid: 'group2@g.us' }))
        assert.equal(d.isNew, true)
        assert.notEqual(d.id, a.id)
    })
})

test('pending/failed entries refreshed with fresh data on re-enqueue', async () => {
    await withQueue(async (q) => {
        const first = q.enqueue(baseEntry({ messageId: 'm2', materi: 'Old' }))
        assert.equal(first.status, 'pending')

        // Re-enqueue same composite key with updated materi
        const updated = q.enqueue(baseEntry({ messageId: 'm2', materi: 'New' }))
        assert.equal(updated.isNew, false)
        assert.equal(updated.id, first.id)

        const row = q.db.prepare('SELECT materi FROM journal_queue WHERE id = ?').get(first.id)
        assert.equal(row.materi, 'New')
    })
})

test('acquireEntry: only one worker can claim an entry', async () => {
    await withQueue(async (q) => {
        const e = q.enqueue(baseEntry({ messageId: 'm3' }))
        const id = e.id

        const first = q.acquireEntry(id, 'pending')
        const second = q.acquireEntry(id, 'pending')

        assert.equal(first, true)
        assert.equal(second, false)

        const row = q.db.prepare('SELECT status FROM journal_queue WHERE id = ?').get(id)
        assert.equal(row.status, 'processing')
    })
})

test('acquireEntry: fails when status mismatches', async () => {
    await withQueue(async (q) => {
        const e = q.enqueue(baseEntry({ messageId: 'm4' }))
        const id = e.id

        q.updateStatus(id, 'sent')
        const claimed = q.acquireEntry(id, 'pending')

        assert.equal(claimed, false)
    })
})

test('getUnprocessed returns PENDING + retryable FAILED ordered by created_at ASC', async () => {
    await withQueue(async (q) => {
        const a = q.enqueue(baseEntry({ messageId: 'a' }))
        const b = q.enqueue(baseEntry({ messageId: 'b' }))
        const c = q.enqueue(baseEntry({ messageId: 'c' }))

        // Mark b as failed, attempts=1 (< max)
        q.updateStatus(b.id, 'failed', { attempts: 1 })

        // Mark c as sent (should not appear)
        q.updateStatus(c.id, 'sent')

        const pending = q.getUnprocessed('sess1')
        const ids = pending.map((r) => r.id)
        assert.deepEqual(ids, [a.id, b.id])
    })
})

test('processPendingBySession processes only claimed entries (FIFO)', async () => {
    await withQueue(async (q) => {
        const a = q.enqueue(baseEntry({ messageId: 'A' }))
        const b = q.enqueue(baseEntry({ messageId: 'B' }))
        const c = q.enqueue(baseEntry({ messageId: 'C' }))

        // Manually claim B to simulate another worker
        q.acquireEntry(b.id, 'pending')

        // Stub the API so no network call is made
        const originalPost = axios.post
        axios.post = async () => ({
            data: {
                status: 'success',
                data: { jurnal_data: { nama_guru: 'Guru Test', tanggal: '2024-01-15' } },
            },
        })

        try {
            const result = await q.processPendingBySession('sess1')

            // A and C processed (B skipped due to claim)
            assert.equal(result.processed, 2)
            assert.equal(result.sent + result.failed, 2)

            const statusA = q.db.prepare('SELECT status FROM journal_queue WHERE id = ?').get(a.id)
            const statusB = q.db.prepare('SELECT status FROM journal_queue WHERE id = ?').get(b.id)
            const statusC = q.db.prepare('SELECT status FROM journal_queue WHERE id = ?').get(c.id)

            assert.notEqual(statusA.status, 'pending') // sent or failed
            assert.notEqual(statusC.status, 'pending')
            assert.equal(statusB.status, 'processing') // still claimed by fake worker
        } finally {
            axios.post = originalPost
        }
    })
})

test('processEntry: cannot claim an entry already sent', async () => {
    await withQueue(async (q) => {
        const e = q.enqueue(baseEntry({ messageId: 'm5' }))
        q.updateStatus(e.id, 'sent')
        const result = await q.processEntry(q.db.prepare('SELECT * FROM journal_queue WHERE id = ?').get(e.id))
        assert.equal(result.skipped, true)
    })
})

test('legacy DB: migration adds composite unique index', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqtest-'))
    const legacyPath = path.join(dir, 'journal_queue.db')

    try {
        // Create legacy schema with single-column unique
        const legacy = new Database(legacyPath)
        legacy.exec(`
            CREATE TABLE journal_queue (
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
        legacy.close()

        const q = new JournalQueue()
        q.init(dir)
        try {
            // Composite dedup should work now
            const e1 = q.enqueue(baseEntry({ messageId: 'legacy1' }))
            const e2 = q.enqueue(baseEntry({ messageId: 'legacy1' }))
            assert.equal(e1.isNew, true)
            assert.equal(e2.isNew, false)
            assert.equal(e1.id, e2.id)

            // Composite unique index present on migrated legacy DB
            const indexes = q.db.prepare(`PRAGMA index_list('journal_queue')`).all()
            const hasComposite = indexes.some((i) => i.name === 'uq_journal_queue_dedup' && i.unique === 1)
            assert.equal(hasComposite, true)
        } finally {
            q.close()
        }
    } finally {
        rmForce(dir)
    }
})

test('checkMessage with composite key returns entry only for matching session+group', async () => {
    await withQueue(async (q) => {
        q.enqueue(baseEntry({ messageId: 'chk1', sessionId: 's1', groupJid: 'g1@g.us' }))

        assert.ok(q.checkMessage('chk1', 's1', 'g1@g.us'))
        assert.equal(q.checkMessage('chk1', 's2', 'g1@g.us'), null)
        assert.equal(q.checkMessage('chk1', 's1', 'g2@g.us'), null)
    })
})