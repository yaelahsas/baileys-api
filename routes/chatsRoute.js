import { Router } from 'express'
import { body, query } from 'express-validator'
import requestValidator from './../middlewares/requestValidator.js'
import sessionValidator from './../middlewares/sessionValidator.js'
import * as controller from './../controllers/chatsController.js'
import getMessages from './../controllers/getMessages.js'

const isTimestampParam = (value) => {
    if (value === '' || (!Number.isNaN(Number(value)) && Number.isFinite(Number(value)))) return true
    if (!Number.isNaN(Date.parse(value))) return true
    throw new Error('must be a unix timestamp or ISO date')
}

const router = Router()

router.get('/', query('id').notEmpty(), requestValidator, sessionValidator, controller.getList)

router.get(
    '/:jid',
    query('id').notEmpty(),
    query('from').optional().custom(isTimestampParam),
    query('to').optional().custom(isTimestampParam),
    requestValidator,
    sessionValidator,
    getMessages,
)

router.post(
    '/delete',
    query('id').notEmpty(),
    body('receiver').notEmpty(),
    body('message').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.deleteChat,
)

router.post(
    '/send',
    query('id').notEmpty(),
    body('receiver').notEmpty(),
    body('message').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.send,
)

router.post('/send-bulk', query('id').notEmpty(), requestValidator, sessionValidator, controller.sendBulk)

router.post(
    '/forward',
    query('id').notEmpty(),
    body('forward').notEmpty(),
    body('receiver').notEmpty(),
    body('isGroup').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.forward,
)

router.post(
    '/read',
    query('id').notEmpty(),
    body('keys').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.read,
)

router.post(
    '/send-presence',
    query('id').notEmpty(),
    body('receiver').notEmpty(),
    body('presence').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.sendPresence,
)

router.post(
    '/download-media',
    query('id').notEmpty(),
    body('remoteJid').notEmpty(),
    body('messageId').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.downloadMedia,
)

router.get(
    '/queue/status/:queueId',
    query('id').notEmpty(),
    requestValidator,
    sessionValidator,
    controller.getMessageQueueStatus,
)

router.get('/queue/stats', query('id').notEmpty(), requestValidator, sessionValidator, controller.getQueueStatistics)

export default router
