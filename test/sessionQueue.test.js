import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionQueue, getSessionQueue, resetSessionQueue } from '../src/modules/sessionQueue.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('executes queued tasks sequentially in FIFO order', async () => {
    const queue = createSessionQueue()
    const executionOrder = []

    const first = queue.enqueue(async () => {
        executionOrder.push('A:start')
        await wait(20)
        executionOrder.push('A:end')
    })
    const second = queue.enqueue(async () => {
        executionOrder.push('B:start')
        await wait(1)
        executionOrder.push('B:end')
    })
    const third = queue.enqueue(() => {
        executionOrder.push('C')
    })

    await Promise.all([first, second, third])

    assert.deepEqual(executionOrder, ['A:start', 'A:end', 'B:start', 'B:end', 'C'])
})

test('continues processing after a queued task fails', async () => {
    const queue = createSessionQueue()
    const executionOrder = []

    const failed = queue.enqueue(async () => {
        executionOrder.push('failed')
        throw new Error('expected failure')
    })
    const next = queue.enqueue(() => {
        executionOrder.push('next')
        return 'completed'
    })

    await assert.rejects(failed, /expected failure/)
    assert.equal(await next, 'completed')
    assert.deepEqual(executionOrder, ['failed', 'next'])
})

test('keeps separate session queues independent and supports reset', async () => {
    const firstQueue = getSessionQueue('session-a')
    const sameQueue = getSessionQueue('session-a')
    const otherQueue = getSessionQueue('session-b')

    assert.equal(firstQueue, sameQueue)
    assert.notEqual(firstQueue, otherQueue)

    resetSessionQueue('session-a')

    assert.notEqual(getSessionQueue('session-a'), firstQueue)
    resetSessionQueue('session-a')
    resetSessionQueue('session-b')
})
