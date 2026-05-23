import { Router } from 'express'
import { getListSessions, getSession, isSessionConnected } from '../whatsapp.js'
import {
    info,
    success,
    error,
    warning,
} from '../src/utils/logger.js'

const router = Router()

/**
 * Track consecutive unhealthy healthcheck failures
 * When this reaches DOCKER_UNHEALTHY_RESTART_THRESHOLD, process.exit(1) is called
 * so Docker's restart:unless-stopped policy will restart the container
 * @type {number}
 */
let unhealthyCount = 0

/**
 * How many consecutive unhealthy checks before forcing process exit
 * This triggers Docker's restart:unless-stopped to restart the container
 * @type {number}
 */
const DOCKER_UNHEALTHY_RESTART_THRESHOLD = parseInt(process.env.DOCKER_UNHEALTHY_RESTART_THRESHOLD ?? 3)

/**
 * Health check endpoint for Docker healthcheck and monitoring
 * Returns the health status of the server and all WhatsApp sessions
 * 
 * CRITICAL: When unhealthy for DOCKER_UNHEALTHY_RESTART_THRESHOLD consecutive checks,
 * this endpoint calls process.exit(1) which triggers Docker's restart:unless-stopped
 * to automatically restart the container.
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

    // Track consecutive unhealthy checks for Docker auto-restart
    if (isHealthy) {
        unhealthyCount = 0
    } else {
        unhealthyCount++
        warning('HealthCheck', `Unhealthy check #${unhealthyCount}/${DOCKER_UNHEALTHY_RESTART_THRESHOLD}`, {
            sessions: sessionsHealth,
        })

        // If unhealthy for threshold consecutive checks, force process exit
        // Docker's restart:unless-stopped will then restart the container
        if (unhealthyCount >= DOCKER_UNHEALTHY_RESTART_THRESHOLD) {
            error('HealthCheck', `Max unhealthy checks reached (${DOCKER_UNHEALTHY_RESTART_THRESHOLD}), forcing container restart via process.exit(1)`)
            // Send response first so the healthcheck caller gets the answer
            res.status(503).json({
                status: 'unhealthy',
                message: `Force restarting container after ${DOCKER_UNHEALTHY_RESTART_THRESHOLD} consecutive unhealthy checks`,
                unhealthyCount,
                threshold: DOCKER_UNHEALTHY_RESTART_THRESHOLD,
                sessions: {
                    total: sessionIds.length,
                    authenticated: sessionsHealth.filter(s => s.isAuthenticated).length,
                    details: sessionsHealth,
                },
            })
            // Exit process with error code - Docker will restart because of restart:unless-stopped
            // Use a small delay to ensure the response is sent before exit
            setTimeout(() => process.exit(1), 100)
            return
        }
    }

    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'unhealthy',
        unhealthyCount,
        threshold: DOCKER_UNHEALTHY_RESTART_THRESHOLD,
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
