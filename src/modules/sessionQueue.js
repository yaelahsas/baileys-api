const sessionQueues = new Map()

const createSessionQueue = () => {
    let tail = Promise.resolve()

    return {
        enqueue(task) {
            const result = tail.then(() => task())
            tail = result.catch(() => undefined)
            return result
        },
    }
}

const getSessionQueue = (sessionId) => {
    if (!sessionQueues.has(sessionId)) {
        sessionQueues.set(sessionId, createSessionQueue())
    }

    return sessionQueues.get(sessionId)
}

const resetSessionQueue = (sessionId) => sessionQueues.delete(sessionId)

export { createSessionQueue, getSessionQueue, resetSessionQueue }
