/**
 * Logger Utility Module
 * 
 * Provides centralized, structured logging with color-coded output
 * for easy tracking of message flows, API calls, and reports.
 * 
 * Features:
 * - Color-coded log levels
 * - Timestamps
 * - Context-aware logging
 * - Easy-to-read format
 */

/**
 * ANSI color codes for terminal output
 */
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',
    hidden: '\x1b[8m',
    
    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    
    // Background colors
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
}

/**
 * Log levels with their colors and icons
 */
const logLevels = {
    INFO: { color: colors.blue, icon: 'ℹ️', label: 'INFO' },
    SUCCESS: { color: colors.green, icon: '✅', label: 'SUCCESS' },
    WARNING: { color: colors.yellow, icon: '⚠️', label: 'WARNING' },
    ERROR: { color: colors.red, icon: '❌', label: 'ERROR' },
    DEBUG: { color: colors.dim, icon: '🔍', label: 'DEBUG' },
    INCOMING: { color: colors.cyan, icon: '📥', label: 'INCOMING' },
    OUTGOING: { color: colors.magenta, icon: '📤', label: 'OUTGOING' },
    API: { color: colors.yellow, icon: '🌐', label: 'API' },
    QUEUE: { color: colors.blue, icon: '📋', label: 'QUEUE' },
    WEBHOOK: { color: colors.magenta, icon: '🔔', label: 'WEBHOOK' },
    COMMAND: { color: colors.green, icon: '⚡', label: 'COMMAND' },
    EVENT: { color: colors.cyan, icon: '📡', label: 'EVENT' },
}

/**
 * Get formatted timestamp
 * @returns {string} Formatted timestamp
 */
const getTimestamp = () => {
    const now = new Date()
    const date = now.toISOString().split('T')[0]
    const time = now.toTimeString().split(' ')[0]
    const ms = now.getMilliseconds().toString().padStart(3, '0')
    return `${date} ${time}.${ms}`
}

/**
 * Format log message with colors and structure
 * @param {string} level - Log level
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const formatLog = (level, context, message, data = null) => {
    const levelConfig = logLevels[level] || logLevels.INFO
    const timestamp = getTimestamp()
    
    let logMessage = `${colors.dim}[${timestamp}]${colors.reset} `
    logMessage += `${levelConfig.color}${levelConfig.icon} [${levelConfig.label}]${colors.reset} `
    logMessage += `${colors.bright}${context}${colors.reset}: ${message}`
    
    if (data) {
        logMessage += `\n${colors.dim}└─ Data: ${JSON.stringify(data, null, 2)}${colors.reset}`
    }
    
    return logMessage
}

/**
 * Log an info message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const info = (context, message, data = null) => {
    console.log(formatLog('INFO', context, message, data))
}

/**
 * Log a success message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const success = (context, message, data = null) => {
    console.log(formatLog('SUCCESS', context, message, data))
}

/**
 * Log a warning message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const warning = (context, message, data = null) => {
    console.log(formatLog('WARNING', context, message, data))
}

/**
 * Log an error message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const error = (context, message, data = null) => {
    console.error(formatLog('ERROR', context, message, data))
}

/**
 * Log a debug message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const debug = (context, message, data = null) => {
    if (process.env.DEBUG === 'true') {
        console.log(formatLog('DEBUG', context, message, data))
    }
}

/**
 * Log an incoming message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const incoming = (context, message, data = null) => {
    console.log(formatLog('INCOMING', context, message, data))
}

/**
 * Log an outgoing message
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const outgoing = (context, message, data = null) => {
    console.log(formatLog('OUTGOING', context, message, data))
}

/**
 * Log an API call
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const api = (context, message, data = null) => {
    console.log(formatLog('API', context, message, data))
}

/**
 * Log a queue operation
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const queue = (context, message, data = null) => {
    console.log(formatLog('QUEUE', context, message, data))
}

/**
 * Log a webhook operation
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const webhook = (context, message, data = null) => {
    console.log(formatLog('WEBHOOK', context, message, data))
}

/**
 * Log a command operation
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const command = (context, message, data = null) => {
    console.log(formatLog('COMMAND', context, message, data))
}

/**
 * Log an event
 * @param {string} context - Context/module name
 * @param {string} message - Log message
 * @param {object} data - Additional data to log
 */
const event = (context, message, data = null) => {
    console.log(formatLog('EVENT', context, message, data))
}

/**
 * Log a separator line
 * @param {string} title - Optional title for the separator
 */
const separator = (title = '') => {
    if (title) {
        console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`)
        console.log(`${colors.bright}${colors.cyan}  ${title}${colors.reset}`)
        console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`)
    } else {
        console.log(`${colors.dim}───────────────────────────────────────────────────────────────────────────────${colors.reset}`)
    }
}

/**
 * Log message flow tracking
 * @param {string} action - Action being performed
 * @param {string} messageId - Message ID
 * @param {string} from - Sender
 * @param {string} to - Recipient
 * @param {string} type - Message type
 */
const messageFlow = (action, messageId, from, to, type) => {
    const timestamp = getTimestamp()
    console.log(`${colors.dim}[${timestamp}]${colors.reset} ${colors.cyan}📨 [MESSAGE_FLOW]${colors.reset} ${colors.bright}${action}${colors.reset}`)
    console.log(`${colors.dim}├─ Message ID: ${messageId}${colors.reset}`)
    console.log(`${colors.dim}├─ From: ${from}${colors.reset}`)
    console.log(`${colors.dim}├─ To: ${to}${colors.reset}`)
    console.log(`${colors.dim}└─ Type: ${type}${colors.reset}`)
}

/**
 * Log API request/response
 * @param {string} type - Request or Response
 * @param {string} method - HTTP method
 * @param {string} url - API URL
 * @param {object} data - Request/response data
 */
const apiCall = (type, method, url, data = null) => {
    const timestamp = getTimestamp()
    const color = type === 'REQUEST' ? colors.yellow : colors.green
    console.log(`${colors.dim}[${timestamp}]${colors.reset} ${color}🌐 [API_${type}]${colors.reset} ${colors.bright}${method}${colors.reset} ${url}`)
    if (data) {
        console.log(`${colors.dim}└─ Data: ${JSON.stringify(data, null, 2)}${colors.reset}`)
    }
}

/**
 * Log report generation
 * @param {string} reportType - Type of report
 * @param {string} status - Status (generating, completed, failed)
 * @param {object} details - Report details
 */
const report = (reportType, status, details = null) => {
    const timestamp = getTimestamp()
    const color = status === 'completed' ? colors.green : status === 'failed' ? colors.red : colors.yellow
    console.log(`${colors.dim}[${timestamp}]${colors.reset} ${color}📊 [REPORT]${colors.reset} ${colors.bright}${reportType}${colors.reset} - ${status}`)
    if (details) {
        console.log(`${colors.dim}└─ Details: ${JSON.stringify(details, null, 2)}${colors.reset}`)
    }
}

export {
    info,
    success,
    warning,
    error,
    debug,
    incoming,
    outgoing,
    api,
    queue,
    webhook,
    command,
    event,
    separator,
    messageFlow,
    apiCall,
    report,
}
