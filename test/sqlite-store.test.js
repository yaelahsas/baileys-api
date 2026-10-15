import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SQLiteStore } from '../store/sqlite-store.js'

const createStore = (retentionDays = 90) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-sastra-store-'))
    const store = new SQLiteStore({ dbFile: path.join(directory, 'messages.db'), retentionDays, pruneInterval: 0 })
    return { store, directory }
}

const message = (id, timestamp, jid = '120363000000000000@g.us') => ({
    key: { id, remoteJid: jid, fromMe: false, participant: '628123456789@s.whatsapp.net' },
    messageTimestamp: timestamp,
    message: { conversation: id },
})

test('queries messages by indexed date range and cursor', async (t) => {
    const { store, directory } = createStore()
    t.after(() => {
        store.cleanup()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    for (let timestamp = 100; timestamp <= 500; timestamp += 100)
        store.upsertMessage(message(`m${timestamp}`, timestamp))

    const ranged = await store.loadMessages('120363000000000000@g.us', 10, null, { from: 200, to: 400 })
    assert.deepEqual(
        ranged.map((item) => item.key.id),
        ['m400', 'm300', 'm200'],
    )

    const paged = await store.loadMessages('120363000000000000@g.us', 2, { before: { id: 'm400', fromMe: false } })
    assert.deepEqual(
        paged.map((item) => item.key.id),
        ['m300', 'm200'],
    )
})

test('prunes messages older than the configured retention period', async (t) => {
    const { store, directory } = createStore(1)
    t.after(() => {
        store.cleanup()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    store.upsertMessage(message('old', 100))
    store.upsertMessage(message('current', 200000))

    assert.equal(store.pruneMessages(200000), 1)
    assert.deepEqual(
        (await store.loadMessages('120363000000000000@g.us', 10)).map((item) => item.key.id),
        ['current'],
    )
})

test('migrates the legacy JSON store only once', async (t) => {
    const { store, directory } = createStore(0)
    t.after(() => {
        store.cleanup()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const legacyFile = path.join(directory, 'legacy.json')
    fs.writeFileSync(
        legacyFile,
        JSON.stringify({ messages: { '120363000000000000@g.us': [['legacy', message('legacy', 100)]] } }),
    )

    store.readFromFile(legacyFile)
    store.readFromFile(legacyFile)

    assert.equal((await store.loadMessages('120363000000000000@g.us', 10)).length, 1)
})
