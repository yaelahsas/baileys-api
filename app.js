import 'dotenv/config'
import express from 'express'
import nodeCleanup from 'node-cleanup'
import routes from './routes.js'
import { init, cleanup } from './whatsapp.js'
import cors from 'cors'
import {
    info,
    success,
    error,
    separator,
} from './src/utils/logger.js'

const app = express()

const host = process.env.HOST || undefined
const port = parseInt(process.env.PORT ?? 8000)

app.use(cors())
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use('/', routes)

const listenerCallback = () => {
    separator('SERVER STARTUP')
    info('App', 'Starting server', {
        host: host || 'localhost',
        port,
        environment: process.env.NODE_ENV || 'development',
    })
    
    init()
    
    success('App', 'Server started successfully', {
        url: `http://${host ? host : 'localhost'}:${port}`,
    })
}

if (host) {
    app.listen(port, host, listenerCallback)
} else {
    app.listen(port, listenerCallback)
}

nodeCleanup(() => {
    info('App', 'Shutdown signal received, running cleanup...')
    cleanup()
    success('App', 'Server shutdown completed')
})

export default app
