import { rmSync, readdir, existsSync } from 'fs'
import { join } from 'path'
import pino from 'pino'
import makeWASocketModule, {
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    delay,
    downloadMediaMessage,
    getAggregateVotesInPollMessage,
    fetchLatestBaileysVersion,
    WAMessageStatus,
} from 'baileys'

import proto from 'baileys'

import makeInMemoryStore from './store/memory-store.js'

import { toDataURL } from 'qrcode'
import __dirname from './dirname.js'
import response from './response.js'
import { downloadImage } from './utils/download.js'
import axios from 'axios'
import NodeCache from 'node-cache'
import FormData from 'form-data'

const msgRetryCounterCache = new NodeCache()

const sessions = new Map()
const retries = new Map()

const APP_WEBHOOK_ALLOWED_EVENTS = process.env.APP_WEBHOOK_ALLOWED_EVENTS.split(',')

const sessionsDir = (sessionId = '') => {
    return join(__dirname, 'sessions', sessionId ? sessionId : '')
}

const isSessionExists = (sessionId) => {
    return sessions.has(sessionId)
}

const isSessionConnected = (sessionId) => {
    return sessions.get(sessionId)?.ws?.socket?.readyState === 1
}

const shouldReconnect = (sessionId) => {
    const maxRetries = parseInt(process.env.MAX_RETRIES ?? 0)
    let attempts = retries.get(sessionId) ?? 0

    // MaxRetries = maxRetries < 1 ? 1 : maxRetries
    if (attempts < maxRetries || maxRetries === -1) {
        ++attempts

        console.log('Reconnecting...', { attempts, sessionId })
        retries.set(sessionId, attempts)

        return true
    }

    return false
}

const callWebhook = async (instance, eventType, eventData) => {
    if (APP_WEBHOOK_ALLOWED_EVENTS.includes('ALL') || APP_WEBHOOK_ALLOWED_EVENTS.includes(eventType)) {
        await webhook(instance, eventType, eventData)
    }
}
const handleGroupCommands = async (wa, msg, sessionId) => {
    try {
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        // Kalau pesan kosong atau bukan teks, skip
        if (!messageContent) return false

        const text = messageContent.trim().toLowerCase()

        // Ambil kata pertama sebagai command
        const command = text.split(' ')[0]

        // ===== LIST COMMAND YANG DIKENALI =====
        const knownCommands = ['#laporan', '#jurnal']

        // Kalau bukan command yang kita kenal, abaikan saja
        if (!knownCommands.includes(command)) {
            return false
        }

        // ===== GLOBAL AUTHORIZATION CHECK =====
        const sender = msg.key.participantAlt || msg.key.remoteJid
        const phoneNumber = sender.replace(/[@s.whatsapp.net@g.us]/g, '')

        const authorizedNumbers = ['6285212870484', '6283853399847'] // Ganti dengan nomor yang diizinkan
        const isAuthorized = authorizedNumbers.includes(phoneNumber)

        if (!isAuthorized) {
            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Anda tidak dapat menggunakan fitur ini.',
            })

            return true
        }

        switch (command) {
            case '#laporan': {
                // ===== PANGGIL FUNGSI LAMA TANPA DIUBAH =====
                await handleReportCommand(wa, msg, sessionId)

                return true
            }

            case '#jurnal': {
                // ===== FITUR BARU: JURNAL VIA QUOTED IMAGE =====
                const parts = text.split(' ')
                let tanggalInput = null

                // cek apakah user kirim tanggal
                if (parts.length > 1) {
                    tanggalInput = parts[1]
                }

                // validasi format tanggal jika ada
                let tanggalFinal = null

                if (tanggalInput) {
                    const regex = /^(\d{2})-(\d{2})-(\d{4})$/

                    if (!regex.test(tanggalInput)) {
                        await wa.sendMessage(msg.key.remoteJid, {
                            text: 'Format tanggal salah. Gunakan format: #jurnal DD-MM-YYYY\nContoh: #jurnal 03-02-2026',
                        })
                        return true
                    }

                    // convert ke format YYYY-MM-DD untuk API
                    const [dd, mm, yyyy] = tanggalInput.split('-')
                    tanggalFinal = `${yyyy}-${mm}-${dd}`
                }

                // Cek apakah pesan ini mereply sesuatu
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
                const contextInfo = msg
                console.log('Quoted message:', contextInfo)

                if (!quoted) {
                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Harap reply sebuah gambar untuk menggunakan perintah #jurnal',
                    })
                    return true
                }

                // Pastikan yang direply adalah gambar
                if (!quoted.imageMessage) {
                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Pesan yang direply bukan gambar. Mohon reply pesan gambar.',
                    })
                    return true
                }

                // Bangun ulang format message agar kompatibel dengan fungsi lama
                // const fakeMsg = {
                //     key: msg.message.extendedTextMessage.contextInfo,
                //     message: {
                //         imageMessage: quoted.imageMessage,
                //     },
                //     pushName: msg.pushName,
                // }

                console.log('Processing jurnal from quoted image...')

                // Pakai fungsi jurnal lama tanpa perubahan
                await handleGroupImageMessage(wa, msg, sessionId, tanggalFinal)

                return true
            }

            default:
                // Bukan command yang kita kenal
                return false
        }
    } catch (error) {
        console.error('Error in handleGroupCommands:', error)

        await wa.sendMessage(msg.key.remoteJid, {
            text: 'Terjadi kesalahan saat memproses perintah.',
        })

        return true
    }
}

const handleGroupImageMessage = async (wa, msg, sessionId, tanggalCustom = null) => {
    try {
        // Extract participant information
        const participant = msg.key.participant || ''
        const participantAlt = msg.key.participantAlt || ''

        let phoneNumber = ''
        let lid = ''
        let quoted = false

        // ===== MODE QUOTED MESSAGE =====
        if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
            const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant
            quoted = true
            console.log('Using quoted participant as sender:', quotedParticipant)

            lid = quotedParticipant.replace('@lid', '')
        }
        // ===== MODE NORMAL (TANPA QUOTE) =====
        else {
            const participant = msg.key.participant || ''
            const participantAlt = msg.key.participantAlt || ''

            if (participantAlt) {
                phoneNumber = participantAlt.replace('@s.whatsapp.net', '')
            } else if (participant) {
                phoneNumber = participant.replace('@s.whatsapp.net', '')
            } else if (msg.key.remoteJid) {
                phoneNumber = msg.key.remoteJid.replace('@s.whatsapp.net', '')
            }

            if (participant) {
                lid = participant.replace('@lid', '')
            } else if (msg.key.remoteJid) {
                lid = msg.key.remoteJid.replace('@lid', '')
            }
        }

        console.log('Final sender used for jurnal:', {
            phoneNumber,
            lid,
        })

        let mediaMessage

        // Kalau message ini datang dari quoted
        if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage

            console.log('Processing media from quoted message')

            const buffer = await downloadMediaMessage(
                {
                    key: msg.key,
                    message: quoted,
                },
                'buffer',
                {},
                { reuploadRequest: wa.updateMediaMessage },
            )

            const imageData = quoted.imageMessage

            mediaMessage = {
                messageType: 'imageMessage',
                fileName: '',
                caption: imageData.caption || '',
                size: {
                    fileLength: imageData.fileLength,
                    height: imageData.height,
                    width: imageData.width,
                },
                mimetype: imageData.mimetype,
                base64: buffer.toString('base64'),
            }
        } else {
            // Mode normal (gambar langsung)
            mediaMessage = await getMessageMedia(wa, msg)
        }

        // tentukan tanggal
        let tanggalKirim = tanggalCustom

        if (!tanggalKirim) {
            const today = new Date()
            tanggalKirim = today.toISOString().split('T')[0] // YYYY-MM-DD
        }
        // Create data object for the API request
        const data = {
            no_lid: lid,
            keterangan: 'Jurnal via WhatsApp Bot',
            foto: `data:${mediaMessage.mimetype};base64,${mediaMessage.base64}`,
            tanggal: tanggalKirim,
        }

        console.log('Sending jurnal data to API:', { no_telpon: phoneNumber, no_lid: lid })

        // Send to API endpoint with JSON format and API key
        const response = await axios.post('http://10.46.1.16:9998/api/create_jurnal', data, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': 'whatsapp_bot_key_2024',
            },
        })

        // Check if response is successful
        if (response.data && response.data.status === 'success') {
            const jurnalData = response.data.data.jurnal_data
            const successMessage = `Pengisian jurnal atas nama ${jurnalData.nama_guru} berhasil dilakukan pada tanggal ${jurnalData.tanggal}`

            // Send success message to the group
            // await wa.sendMessage(msg.key.remoteJid, { text: successMessage })
            await wa.sendMessage(msg.key.remoteJid, { text: successMessage }, { quoted: msg })

            // Send success report to specific phone number
            const reportNumber = '6283853399847@s.whatsapp.net'
            const reportMessage = `Laporan: ${successMessage}\n\nOleh: ${msg.pushName} (${phoneNumber})`
            await wa.sendMessage(reportNumber, { text: reportMessage })
        }
    } catch (error) {
        console.error('Error handling group image message:', error)
    }
}

const handleReportCommand = async (wa, msg, sessionId) => {
    try {
        // Extract message content
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        // Check if message starts with #laporan
        if (!messageContent.toLowerCase().startsWith('#laporan')) {
            return
        }

        // Extract command parameters
        const commandParts = messageContent.toLowerCase().split(' ')
        const reportType = commandParts[1] || 'bulanan' // Default to bulanan
        const currentYear = new Date().getFullYear()
        const currentMonth = new Date().getMonth() + 1

        // API configuration
        const base_url = 'http://10.46.1.16:9998/api'
        const api_key = 'whatsapp_bot_key_2024'

        let url = `${base_url}/get_laporan_pdf?tipe_laporan=${reportType}&tahun=${currentYear}`
        let filename = `laporan_${reportType}_${currentYear}.pdf`

        // Handle different report types
        if (reportType === 'bulanan') {
            const monthName = commandParts[2] || ''
            if (monthName) {
                const monthMap = {
                    januari: 1,
                    februari: 2,
                    maret: 3,
                    april: 4,
                    mei: 5,
                    juni: 6,
                    juli: 7,
                    agustus: 8,
                    september: 9,
                    oktober: 10,
                    november: 11,
                    desember: 12,
                }
                const monthNum = monthMap[monthName] || currentMonth
                url += `&bulan=${monthNum}`
                filename = `laporan_bulanan_${monthNum}_${currentYear}.pdf`
            } else {
                url += `&bulan=${currentMonth}`
                filename = `laporan_bulanan_${currentMonth}_${currentYear}.pdf`
            }
        } else if (reportType === 'guru') {
            // ambil no_lid dari command atau participant
            let no_lid = commandParts[2] || msg.key.participant || ''

            // hapus semua simbol @ dan domain WA
            no_lid = no_lid.replace(/[@a-z.]/gi, '')

            if (no_lid) {
                url += `&no_lid=${no_lid}&bulan=${currentMonth}`
                filename = `laporan_${reportType}_${no_lid}_${currentMonth}_${currentYear}.pdf`
            } else {
                url += `&id=1&bulan=${currentMonth}`
                filename = `laporan_${reportType}_1_${currentMonth}_${currentYear}.pdf`
            }
        } else if (['kelas', 'mapel'].includes(reportType)) {
            const id = commandParts[2] || '1'
            url += `&id=${id}&bulan=${currentMonth}`
            filename = `laporan_${reportType}_${id}_${currentMonth}_${currentYear}.pdf`
        } else if (reportType === 'rekap_kehadiran') {
            url += `&bulan=${currentMonth}`
            filename = `rekap_kehadiran_${currentMonth}_${currentYear}.pdf`
        }

        // Send processing message

        // Fetch PDF from API
        const response = await axios.get(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': api_key,
            },
            responseType: 'arraybuffer',
        })

        if (response.status === 200) {
            // Convert PDF buffer to base64
            const pdfBase64 = Buffer.from(response.data, 'binary').toString('base64')

            // Send PDF document to group
            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    document: { url: `data:application/pdf;base64,${pdfBase64}` },
                    fileName: filename,
                    mimetype: 'application/pdf',
                    caption: `Berikut adalah laporan ${reportType} yang diminta`,
                },
                { quoted: msg },
            )

            console.log(`Report sent successfully: ${filename}`)
        } else {
            await wa.sendMessage(msg.key.remoteJid, { text: 'Maaf, terjadi kesalahan saat mengambil laporan.' }, { quoted: msg })
        }
    } catch (error) {
        console.error('Error handling report command:', error)
        await wa.sendMessage(msg.key.remoteJid, { text: 'Maaf, terjadi kesalahan saat memproses permintaan laporan.' }, { quoted: msg })
    }
}

const webhook = async (instance, type, data) => {
    if (process.env.APP_WEBHOOK_URL) {
        axios
            .post(`${process.env.APP_WEBHOOK_URL}`, {
                instance,
                type,
                data,
            })
            .then((success) => {
                return success
            })
            .catch((error) => {
                return error
            })
    }
}

const createSession = async (sessionId, res = null, options = { usePairingCode: false, phoneNumber: '' }) => {
    const sessionFile = 'md_' + sessionId

    const logger = pino({ level: 'silent' })
    const store = makeInMemoryStore({
        preserveDataDuringSync: true,
        backupBeforeSync: false,
        incrementalSave: true,
        maxMessagesPerChat: 150,
        autoSaveInterval: 10000,
        storeFile: sessionsDir(`${sessionId}_store.json`),
    })

    const { state, saveCreds } = await useMultiFileAuthState(sessionsDir(sessionFile))

    // Fetch latest version of WA Web
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

    // Load store
    store?.readFromFile(sessionsDir(`${sessionId}_store.json`))

    // Make both Node and Bun compatible
    const makeWASocket = makeWASocketModule.default ?? makeWASocketModule

    /**
     * @type {import('baileys').AnyWASocket}
     */
    const wa = makeWASocket({
        version,
        printQRInTerminal: false,
        mobile: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        getMessage,
    })
    store?.bind(wa.ev)

    sessions.set(sessionId, { ...wa, store })

    if (options.usePairingCode && !wa.authState.creds.registered) {
        if (!wa.authState.creds.account) {
            await wa.waitForConnectionUpdate((update) => {
                return Boolean(update.qr)
            })
            const code = await wa.requestPairingCode(options.phoneNumber)
            if (res && !res.headersSent && code !== undefined) {
                response(res, 200, true, 'Verify on your phone and enter the provided code.', { code })
            } else {
                response(res, 500, false, 'Unable to create session.')
            }
        }
    }

    wa.ev.on('creds.update', saveCreds)

    wa.ev.on('chats.set', ({ chats }) => {
        callWebhook(sessionId, 'CHATS_SET', chats)
    })

    wa.ev.on('chats.upsert', (c) => {
        callWebhook(sessionId, 'CHATS_UPSERT', c)
    })

    wa.ev.on('chats.delete', (c) => {
        callWebhook(sessionId, 'CHATS_DELETE', c)
    })

    wa.ev.on('chats.update', (c) => {
        callWebhook(sessionId, 'CHATS_UPDATE', c)
    })

    wa.ev.on('labels.association', (l) => {
        callWebhook(sessionId, 'LABELS_ASSOCIATION', l)
    })

    wa.ev.on('labels.edit', (l) => {
        callWebhook(sessionId, 'LABELS_EDIT', l)
    })

    // Automatically read incoming messages, uncomment below codes to enable this behaviour
    wa.ev.on('messages.upsert', async (m) => {
        const messages = m.messages.filter((m) => {
            return m.key.fromMe === false
        })
        if (messages.length > 0) {
            // Mark messages as read if auto-read is enabled
            if (process.env.AUTO_READ_MESSAGES === 'true') {
                try {
                    await wa.readMessages(messages.map((msg) => msg.key))
                    console.log(`Marked ${messages.length} message(s) as read`)
                } catch (error) {
                    console.error('Failed to mark messages as read:', error)
                }
            }

            const messageTmp = await Promise.all(
                messages.map(async (msg) => {
                    try {
                        console.log('Processing incoming message:', msg)
                        const typeMessage = Object.keys(msg.message)[0]
                        if (msg?.status) {
                            msg.status = WAMessageStatus[msg?.status] ?? 'UNKNOWN'
                        }

                        // Handle image messages from groups
                        if (typeMessage === 'imageMessage' && msg.key.remoteJid.endsWith('@g.us')) {
                            await handleGroupImageMessage(wa, msg, sessionId)
                        }

                        // Handle report commands from groups
                        if (
                            msg.key.remoteJid.endsWith('@g.us') &&
                            (typeMessage === 'conversation' || typeMessage === 'extendedTextMessage')
                        ) {
                            const handled = await handleGroupCommands(wa, msg, sessionId)

                            // Kalau sudah diproses sebagai command, stop di sini
                            if (handled) {
                                return
                            }
                        }

                        if (
                            ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage'].includes(typeMessage) &&
                            process.env.APP_WEBHOOK_FILE_IN_BASE64 === 'true'
                        ) {
                            const mediaMessage = await getMessageMedia(wa, msg)

                            const fieldsToConvert = [
                                'fileEncSha256',
                                'mediaKey',
                                'fileSha256',
                                'jpegThumbnail',
                                'thumbnailSha256',
                                'thumbnailEncSha256',
                                'streamingSidecar',
                            ]

                            fieldsToConvert.forEach((field) => {
                                if (msg.message[typeMessage]?.[field] !== undefined) {
                                    msg.message[typeMessage][field] = convertToBase64(msg.message[typeMessage][field])
                                }
                            })

                            return {
                                ...msg,
                                message: {
                                    [typeMessage]: {
                                        ...msg.message[typeMessage],
                                        fileBase64: mediaMessage.base64,
                                    },
                                },
                            }
                        }

                        return msg
                    } catch {
                        return {}
                    }
                }),
            )

            callWebhook(sessionId, 'MESSAGES_UPSERT', messageTmp)
        }
    })

    wa.ev.on('messages.delete', async (m) => {
        callWebhook(sessionId, 'MESSAGES_DELETE', m)
    })

    wa.ev.on('messages.update', async (m) => {
        for (const { key, update } of m) {
            const msg = await getMessage(key)

            if (!msg) {
                continue
            }

            update.status = WAMessageStatus[update.status]
            const messagesUpdate = [
                {
                    key,
                    update,
                    message: msg,
                },
            ]
            callWebhook(sessionId, 'MESSAGES_UPDATE', messagesUpdate)
        }
    })

    wa.ev.on('message-receipt.update', async (m) => {
        for (const { key, messageTimestamp, pushName, broadcast, update } of m) {
            if (update?.pollUpdates) {
                const pollCreation = await getMessage(key)
                if (pollCreation) {
                    const pollMessage = await getAggregateVotesInPollMessage({
                        message: pollCreation,
                        pollUpdates: update.pollUpdates,
                    })
                    update.pollUpdates[0].vote = pollMessage
                    callWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', [
                        { key, messageTimestamp, pushName, broadcast, update },
                    ])
                    return
                }
            }
        }

        callWebhook(sessionId, 'MESSAGES_RECEIPT_UPDATE', m)
    })

    wa.ev.on('messages.reaction', async (m) => {
        callWebhook(sessionId, 'MESSAGES_REACTION', m)
    })

    wa.ev.on('messages.media-update', async (m) => {
        callWebhook(sessionId, 'MESSAGES_MEDIA_UPDATE', m)
    })

    wa.ev.on('messaging-history.set', async (m) => {
        callWebhook(sessionId, 'MESSAGING_HISTORY_SET', m)
    })

    wa.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        const statusCode = lastDisconnect?.error?.output?.statusCode

        callWebhook(sessionId, 'CONNECTION_UPDATE', update)

        if (connection === 'open') {
            retries.delete(sessionId)
        }

        if (connection === 'close') {
            if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
                if (res && !res.headersSent) {
                    response(res, 500, false, 'Unable to create session.')
                }

                return deleteSession(sessionId)
            }

            setTimeout(
                () => {
                    createSession(sessionId, res)
                },
                statusCode === DisconnectReason.restartRequired ? 0 : parseInt(process.env.RECONNECT_INTERVAL ?? 0),
            )
        }

        if (qr) {
            if (res && !res.headersSent) {
                callWebhook(sessionId, 'QRCODE_UPDATED', update)

                try {
                    const qrcode = await toDataURL(qr)
                    response(res, 200, true, 'QR code received, please scan the QR code.', { qrcode })
                    return
                } catch {
                    response(res, 500, false, 'Unable to create QR code.')
                }
            }

            try {
                await wa.logout()
            } catch {
            } finally {
                deleteSession(sessionId)
            }
        }
    })

    wa.ev.on('groups.upsert', async (m) => {
        callWebhook(sessionId, 'GROUPS_UPSERT', m)
    })

    wa.ev.on('groups.update', async (m) => {
        callWebhook(sessionId, 'GROUPS_UPDATE', m)
    })

    wa.ev.on('group-participants.update', async (m) => {
        callWebhook(sessionId, 'GROUP_PARTICIPANTS_UPDATE', m)
    })

    wa.ev.on('blocklist.set', async (m) => {
        callWebhook(sessionId, 'BLOCKLIST_SET', m)
    })

    wa.ev.on('blocklist.update', async (m) => {
        callWebhook(sessionId, 'BLOCKLIST_UPDATE', m)
    })

    wa.ev.on('contacts.set', async (c) => {
        callWebhook(sessionId, 'CONTACTS_SET', c)
    })

    wa.ev.on('contacts.upsert', async (c) => {
        callWebhook(sessionId, 'CONTACTS_UPSERT', c)
    })

    wa.ev.on('contacts.update', async (c) => {
        callWebhook(sessionId, 'CONTACTS_UPDATE', c)
    })

    wa.ev.on('presence.update', async (p) => {
        callWebhook(sessionId, 'PRESENCE_UPDATE', p)
    })

    async function getMessage(key) {
        if (store) {
            const msg = await store.loadMessages(key.remoteJid, key.id)
            return msg?.message || undefined
        }

        // Only if store is present
        return proto.Message.fromObject({})
    }
}

/**
 * @returns {(import('baileys').AnyWASocket|null)}
 */
const getSession = (sessionId) => {
    return sessions.get(sessionId) ?? null
}

const getListSessions = () => {
    return [...sessions.keys()]
}

const deleteSession = (sessionId) => {
    const sessionFile = 'md_' + sessionId
    const storeFile = `${sessionId}_store.json`
    const rmOptions = { force: true, recursive: true }

    rmSync(sessionsDir(sessionFile), rmOptions)
    rmSync(sessionsDir(storeFile), rmOptions)

    sessions.delete(sessionId)
    retries.delete(sessionId)
}

const getChatList = (sessionId, isGroup = false) => {
    const filter = isGroup ? '@g.us' : '@s.whatsapp.net'
    const chats = getSession(sessionId).store.chats
    return [...chats.values()].filter((chat) => chat.id.endsWith(filter))
}

/**
 * @param {import('baileys').AnyWASocket} session
 */
const isExists = async (session, jid, isGroup = false) => {
    try {
        let result

        if (isGroup) {
            result = await session.groupMetadata(jid)

            return Boolean(result.id)
        }

        ;[result] = await session.onWhatsApp(jid)

        return result.exists
    } catch {
        return false
    }
}

/**
 * @param {import('baileys').AnyWASocket} session
 */
const sendMessage = async (session, receiver, message, options = {}, delayMs = 1000) => {
    try {
        await delay(parseInt(delayMs))
        return await session.sendMessage(receiver, message, options)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

/**
 * @param {import('baileys').AnyWASocket} session
 */
const updateProfileStatus = async (session, status) => {
    try {
        return await session.updateProfileStatus(status)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const updateProfileName = async (session, name) => {
    try {
        return await session.updateProfileName(name)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const getProfilePicture = async (session, jid, type = 'image') => {
    try {
        return await session.profilePictureUrl(jid, type)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const blockAndUnblockUser = async (session, jid, block) => {
    try {
        return await session.updateBlockStatus(jid, block)
    } catch {
        return Promise.reject(null) // eslint-disable-line prefer-promise-reject-errors
    }
}

const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) {
        return phone
    }

    let formatted = phone.replace(/\D/g, '')

    return (formatted += '@s.whatsapp.net')
}

const formatGroup = (group) => {
    if (group.endsWith('@g.us')) {
        return group
    }

    let formatted = group.replace(/[^\d-]/g, '')

    return (formatted += '@g.us')
}

const cleanup = () => {
    console.log('Running cleanup before exit.')

    sessions.forEach((session, sessionId) => {
        session.store.writeToFile(sessionsDir(`${sessionId}_store.json`))
    })
}

const getGroupsWithParticipants = async (session) => {
    return session.groupFetchAllParticipating()
}

const participantsUpdate = async (session, jid, participants, action) => {
    return session.groupParticipantsUpdate(jid, participants, action)
}

const updateSubject = async (session, jid, subject) => {
    return session.groupUpdateSubject(jid, subject)
}

const updateDescription = async (session, jid, description) => {
    return session.groupUpdateDescription(jid, description)
}

const settingUpdate = async (session, jid, settings) => {
    return session.groupSettingUpdate(jid, settings)
}

const leave = async (session, jid) => {
    return session.groupLeave(jid)
}

const inviteCode = async (session, jid) => {
    return session.groupInviteCode(jid)
}

const revokeInvite = async (session, jid) => {
    return session.groupRevokeInvite(jid)
}

const metaData = async (session, req) => {
    return session.groupMetadata(req.groupId)
}

const acceptInvite = async (session, req) => {
    return session.groupAcceptInvite(req.invite)
}

const profilePicture = async (session, jid, urlImage) => {
    const image = await downloadImage(urlImage)
    return session.updateProfilePicture(jid, { url: image })
}

const readMessage = async (session, keys) => {
    return session.readMessages(keys)
}

const getStoreMessage = async (session, messageId, remoteJid) => {
    try {
        return await session.store.loadMessages(remoteJid, messageId)
    } catch {
        // eslint-disable-next-line prefer-promise-reject-errors
        return Promise.reject(null)
    }
}

const getMessageMedia = async (session, message) => {
    try {
        const messageType = Object.keys(message.message)[0]
        const mediaMessage = message.message[messageType]
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            {},
            { reuploadRequest: session.updateMediaMessage },
        )

        return {
            messageType,
            fileName: mediaMessage.fileName ?? '',
            caption: mediaMessage.caption ?? '',
            size: {
                fileLength: mediaMessage.fileLength,
                height: mediaMessage.height ?? 0,
                width: mediaMessage.width ?? 0,
            },
            mimetype: mediaMessage.mimetype,
            base64: buffer.toString('base64'),
        }
    } catch {
        // eslint-disable-next-line prefer-promise-reject-errors
        return Promise.reject(null)
    }
}

const convertToBase64 = (arrayBytes) => {
    const byteArray = new Uint8Array(arrayBytes)
    return Buffer.from(byteArray).toString('base64')
}

const init = () => {
    readdir(sessionsDir(), (err, files) => {
        if (err) {
            throw err
        }

        for (const file of files) {
            if ((!file.startsWith('md_') && !file.startsWith('legacy_')) || file.endsWith('_store')) {
                continue
            }

            const filename = file.replace('.json', '')
            const sessionId = filename.substring(3)
            console.log('Recovering session: ' + sessionId)
            createSession(sessionId)
        }
    })
}

export {
    isSessionExists,
    createSession,
    getSession,
    getListSessions,
    deleteSession,
    getChatList,
    getGroupsWithParticipants,
    isExists,
    sendMessage,
    updateProfileStatus,
    updateProfileName,
    getProfilePicture,
    formatPhone,
    formatGroup,
    cleanup,
    participantsUpdate,
    updateSubject,
    updateDescription,
    settingUpdate,
    leave,
    inviteCode,
    revokeInvite,
    metaData,
    acceptInvite,
    profilePicture,
    readMessage,
    init,
    isSessionConnected,
    getMessageMedia,
    getStoreMessage,
    blockAndUnblockUser,
}
