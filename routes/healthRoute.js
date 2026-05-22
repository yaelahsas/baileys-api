import { Router } from 'express'
import { getListSessions, getSession, isSessionConnected } from '../whatsapp.js'

const router = Router()

/**
 * Health check endpoint for Docker healthcheck and monitoring
 * Returns the health status of the server and all WhatsApp sessions
 */
const healthCheck = (req, res) => {
    const sessionIds = getListSessions()
    const sessionsHealth = sessionIds.map(sessionId => {
        const session = getSession(sessionId)
        const wsState = session?.ws?.socket?.readyState
        const states = ['connecting', 'connected', 'disconnecting', 'disconnected']
        const connectionState = states[wsState] ?? 'unknown'
        const isAuthenticated = connectionState === 'connected' && typeof session?.user !== 'undefined'

        return {
            sessionId,
            connectionState,
            isAuthenticated,
            hasUser: !!session?.user,
            wsReadyState: wsState,
        }
    })

    const allHealthy = sessionsHealth.every(s => s.isAuthenticated)
    const anyConnected = sessionsHealth.some(s => s.connectionState === 'connected' || s.isAuthenticated)

    // If no sessions exist, that's still "healthy" from server perspective
    // but if sessions exist and none are authenticated, that's unhealthy
    const isHealthy = sessionIds.length === 0 || allHealthy || anyConnected

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'unhealthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memoryUsage: process.memoryUsage(),
        sessions: {
            total: sessionIds.length,
            authenticated: sessionsHealth.filter(s => s.isAuthenticated).length,
            connected: sessionsHealth.filter(s => s.connectionState === 'connected').length,
            disconnected: sessionsHealth.filter(s => s.connectionState === 'disconnected').length,
            details: sessionsHealth,
        },
    })
}

router.get('/', healthCheck)

export default router
