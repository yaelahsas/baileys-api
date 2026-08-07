import assert from 'node:assert/strict'
import test from 'node:test'

import makeInMemoryStore from '../store/memory-store.js'

const groupJid = '120363000000000000@g.us'

test('merges sender metadata when the same message is upserted again', async (t) => {
    const store = makeInMemoryStore({ autoSaveInterval: 600000 })
    t.after(() => clearInterval(store.autoSaveTimer))

    await store.processChatMessages(groupJid, [
        {
            key: { id: 'message-1', remoteJid: groupJid },
            message: { imageMessage: { caption: '8K IPS' } },
            messageTimestamp: 100,
        },
    ])
    await store.processChatMessages(groupJid, [
        {
            key: {
                id: 'message-1',
                remoteJid: groupJid,
                participant: '628123456789@s.whatsapp.net',
                participantAlt: '123456789@lid',
            },
            messageTimestamp: 100,
        },
    ])

    const [stored] = await store.loadMessages(groupJid, 'message-1')

    assert.equal(stored.key.participant, '628123456789@s.whatsapp.net')
    assert.equal(stored.key.participantAlt, '123456789@lid')
    assert.equal(stored.message.imageMessage.caption, '8K IPS')
    assert.equal(stored.indexed, true)
})

test('addMessage merges a repeated message instead of replacing existing content', async (t) => {
    const store = makeInMemoryStore({ autoSaveInterval: 600000 })
    t.after(() => clearInterval(store.autoSaveTimer))

    await store.addMessage(groupJid, {
        key: { id: 'message-2', remoteJid: groupJid },
        message: { imageMessage: { caption: '9A IPA' } },
        messageTimestamp: 200,
    })
    await store.addMessage(groupJid, {
        key: {
            id: 'message-2',
            remoteJid: groupJid,
            participant: '628987654321@s.whatsapp.net',
        },
        messageTimestamp: 200,
    })

    const [stored] = await store.loadMessages(groupJid, 'message-2')

    assert.equal(stored.key.participant, '628987654321@s.whatsapp.net')
    assert.equal(stored.message.imageMessage.caption, '9A IPA')
    assert.equal(store.getStats().totalMessages, 1)
})
