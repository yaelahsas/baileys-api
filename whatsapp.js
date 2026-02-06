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
const BOT_START_TIME = Math.floor(Date.now() / 1000)

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
        console.log('==============================================')
        console.log('[COMMAND] Menerima pesan baru di grup')
        console.log('[RAW MESSAGE]:', msg.message)
        console.log('==============================================')

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (!messageContent) {
            console.log('[INFO] Pesan kosong, skip command handler')
            return false
        }

        const text = messageContent.trim().toLowerCase()
        const command = text.split(' ')[0]

        console.log('[INFO] Detected text :', text)
        console.log('[INFO] Detected cmd  :', command)

        // ===== LIST COMMAND YANG DIKENALI =====
        const knownCommands = ['#laporan', '#jurnal']

        if (!knownCommands.includes(command)) {
            console.log('[INFO] Bukan command yang dikenali, skip')
            return false
        }

        // ===== GLOBAL AUTHORIZATION CHECK =====
        const sender = msg.key.participantAlt || msg.key.remoteJid
        const phoneNumber = sender.replace(/[@s.whatsapp.net@g.us]/g, '')

        console.log('[AUTH] Sender     :', sender)
        console.log('[AUTH] Phone Num  :', phoneNumber)

        const authorizedNumbers = ['6285212870484', '6283853399847']
        const isAuthorized = authorizedNumbers.includes(phoneNumber)

        if (!isAuthorized) {
            console.log('[AUTH] Akses ditolak untuk nomor:', phoneNumber)

            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Anda tidak dapat menggunakan fitur ini.',
            })

            return true
        }

        console.log('[AUTH] Akses diizinkan')

        switch (command) {
            case '#laporan': {
                console.log('[COMMAND] Memproses perintah #laporan')

                try {
                    await handleReportCommand(wa, msg, sessionId)
                    console.log('[COMMAND] #laporan selesai diproses')
                } catch (err) {
                    console.error('[ERROR] handleReportCommand gagal:', err)
                }

                return true
            }

            case '#jurnal': {
                console.log('[COMMAND] Memproses perintah #jurnal')

                const parts = text.split(' ')
                let tanggalInput = null

                if (parts.length > 1) {
                    tanggalInput = parts[1]
                }

                let tanggalFinal = null

                if (tanggalInput) {
                    const regex = /^(\d{2})-(\d{2})-(\d{4})$/

                    if (regex.test(tanggalInput)) {
                        const [dd, mm, yyyy] = tanggalInput.split('-')
                        tanggalFinal = `${yyyy}-${mm}-${dd}`

                        console.log('[INFO] Tanggal custom terdeteksi:', tanggalFinal)
                    }
                }

                // cek apakah ada quoted message
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage

                console.log('[INFO] Apakah ada quoted:', quoted ? 'YA' : 'TIDAK')

                if (!quoted) {
                    console.log('[ERROR] #jurnal tanpa reply gambar')

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: `Format salah.

Gunakan:
Reply gambar dengan:

#jurnal 7h matematika algoritma dasar

Atau dengan tanggal:

#jurnal 06-02-2026 7h matematika algoritma dasar`,
                    })

                    return true
                }

                if (!quoted.imageMessage) {
                    console.log('[ERROR] Quoted bukan gambar')

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Pesan yang direply bukan gambar. Mohon reply pesan gambar.',
                    })

                    return true
                }

                console.log('[COMMAND] Valid, lanjut ke handleGroupImageMessage')

                try {
                    await handleGroupImageMessage(wa, msg, sessionId, tanggalFinal)

                    console.log('[SUCCESS] Proses #jurnal selesai')
                } catch (err) {
                    console.error('[ERROR] handleGroupImageMessage gagal:', err)
                }

                return true
            }

            default:
                console.log('[INFO] Command tidak dikenali setelah switch')
                return false
        }
    } catch (error) {
        console.error('==============================================')
        console.error('[ERROR] Exception di handleGroupCommands')
        console.error(error)
        console.error('==============================================')

        await wa.sendMessage(msg.key.remoteJid, {
            text: 'Terjadi kesalahan saat memproses perintah.',
        })

        return true
    }
}
const mapAliasKelas = (kelasInput) => {
    const text = kelasInput.toLowerCase()

    if (text.includes("olim")) {
        if (text.includes("mtk")) return "Olimpiade - MTK"
        if (text.includes("indo")) return "Olimpiade - Indo"
        if (text.includes("ipa")) return "Olimpiade - IPA"
        if (text.includes("ips")) return "Olimpiade - IPS"
        if (text.includes("inggris")) return "Olimpiade - Inggris"
    }

    return kelasInput
}


const handleGroupImageMessage = async (wa, msg, sessionId, tanggalCustom = null) => {
    try {
        console.log('==============================================')
        console.log('[JURNAL] Memulai proses input jurnal')
        console.log('==============================================')

        let lid = ''
        let kelas = ''
        let materi = ''
        let tanggalKirim = tanggalCustom

        // ===== AMBIL LID =====
        if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
            const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant
            lid = quotedParticipant.replace('@lid', '')
            console.log('[INFO] Mode QUOTE - LID dari quoted:', lid)
        } else {
            const participant = msg.key.participant || ''
            lid = participant.replace('@lid', '')
            console.log('[INFO] Mode NORMAL - LID dari pengirim:', lid)
        }

        // ===== AMBIL MEDIA =====
        let mediaMessage

        if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
            console.log('[INFO] Mengambil media dari QUOTED message')

            const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage

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
                mimetype: imageData.mimetype,
                base64: buffer.toString('base64'),
            }
        } else {
            console.log('[INFO] Mengambil media dari pesan langsung')
            mediaMessage = await getMessageMedia(wa, msg)
        }

        // ===== PARSING TEXT =====
        let text = ''

        // Mode dari caption langsung
        if (msg.message?.imageMessage?.caption) {
            text = msg.message.imageMessage.caption.trim()
            console.log('[INFO] Parsing dari CAPTION:', text)
        }
        // Mode dari perintah #jurnal
        else if (msg.message?.extendedTextMessage?.text) {
            text = msg.message.extendedTextMessage.text.trim()
            console.log('[INFO] Parsing dari COMMAND:', text)
        }

        if (!text) {
            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: `Format salah.

Gunakan salah satu format:

📌 Kirim gambar dengan caption:
7h matematika algoritma dasar atau olim-mtk matematika dasar

📌 Reply gambar dengan:
#jurnal 7h matematika algoritma dasar

📌 Dengan tanggal custom:
#jurnal 06-02-2026 7h matematika algoritma dasar`,
                },
                { quoted: msg },
            )

            return
        }

        const parts = text.split(' ')

        // ===== MODE COMMAND #JURNAL =====
        if (parts[0].toLowerCase() === '#jurnal') {
            console.log('[INFO] Mode COMMAND #jurnal terdeteksi')

            // cek apakah ada tanggal custom
            if (parts.length >= 2 && parts[1].match(/^\d{2}-\d{2}-\d{4}$/)) {
                const [dd, mm, yyyy] = parts[1].split('-')
                tanggalKirim = `${yyyy}-${mm}-${dd}`

                kelas = parts[2]
                materi = parts.slice(3).join(' ')

                console.log('[INFO] Tanggal custom:', tanggalKirim)
            } else {
                kelas = parts[1]
                materi = parts.slice(2).join(' ')
            }
        }
        // ===== MODE CAPTION LANGSUNG =====
        else {
            kelas = parts[0]
            materi = parts.slice(1).join(' ')
        }

          kelas = mapAliasKelas(kelas)

        // validasi hasil parsing
        if (!kelas || !materi) {
            console.log('[ERROR] Format parsing gagal:', { kelas, materi })

            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: `Format jurnal salah.

Contoh yang benar:

📌 Kirim gambar langsung:
7h matematika algoritma dasar atau olim-mtk matematika dasar

📌 Atau dengan reply:
#jurnal 7h matematika algoritma dasar

📌 Tanggal custom:
#jurnal 06-02-2026 7h matematika algoritma dasar`,
                },
                { quoted: msg },
            )

            return
        }

        // tanggal default hari ini
        if (!tanggalKirim) {
            tanggalKirim = new Date().toISOString().split('T')[0]
        }

        console.log('[INFO] Hasil parsing final:')
        console.log('- LID    :', lid)
        console.log('- Kelas  :', kelas)
        console.log('- Materi :', materi)
        console.log('- Tanggal:', tanggalKirim)

        // ===== KIRIM KE API =====
        const data = {
            no_lid: lid,
            kelas: kelas,
            materi: materi,
            keterangan: 'Jurnal via WhatsApp Bot',
            foto: `data:${mediaMessage.mimetype};base64,${mediaMessage.base64}`,
            tanggal: tanggalKirim,
        }

        console.log('[INFO] Mengirim data ke API...')

        const response = await axios.post('http://prestasi.test/api/create_jurnal', data, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': 'whatsapp_bot_key_2024',
            },
        })

        if (response.data && response.data.status === 'success') {
            const jurnalData = response.data.data.jurnal_data

            const successMessage =
                `✅ Jurnal berhasil disimpan\n\n` +
                `👨‍🏫 Guru  : ${jurnalData.nama_guru}\n` +
                `🏫 Kelas : ${kelas}\n` +
                `📚 Materi: ${materi}\n` +
                `📅 Tgl   : ${jurnalData.tanggal}`

            await wa.sendMessage(msg.key.remoteJid, { text: successMessage }, { quoted: msg })

            console.log('[SUCCESS] Jurnal berhasil disimpan')
        } else {
            console.log('[ERROR] Response API gagal:', response.data)

            await wa.sendMessage(
                msg.key.remoteJid,
                { text: 'Gagal menyimpan jurnal. Mohon coba lagi.' },
                { quoted: msg },
            )
        }
    } catch (error) {
        console.error('[ERROR] Exception handleGroupImageMessage:', error)

        await wa.sendMessage(msg.key.remoteJid, { text: 'Terjadi kesalahan saat memproses jurnal.' }, { quoted: msg })
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

        // API config
        const base_url = 'http://prestasi.test/api'
        const api_key = 'whatsapp_bot_key_2024'

        const currentYear = new Date().getFullYear()
        const currentMonth = new Date().getMonth() + 1

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

        // DEFAULT
        let reportType = 'bulanan'
        let monthNum = currentMonth
        let monthLabel = Object.keys(monthMap).find((k) => monthMap[k] === currentMonth)

        // ========== LOGIKA UTAMA PARSING ==========

        // #laporan januari
        if (commandParts.length === 2 && monthMap[commandParts[1]]) {
            monthNum = monthMap[commandParts[1]]
            monthLabel = commandParts[1]
        }

        // #laporan bulan januari
        else if (commandParts.length >= 3 && commandParts[1] === 'bulan' && monthMap[commandParts[2]]) {
            monthNum = monthMap[commandParts[2]]
            monthLabel = commandParts[2]
        }

        // #laporan bulanan januari
        else if (commandParts.length >= 3 && commandParts[1] === 'bulanan' && monthMap[commandParts[2]]) {
            monthNum = monthMap[commandParts[2]]
            monthLabel = commandParts[2]
        }

        // #laporan guru @tag atau #laporan guru 628xxx
        else if (commandParts[1] === 'guru') {
            reportType = 'guru'
        }

        // ========== BUILD URL DAN FILENAME ==========

        let url = `${base_url}/get_laporan_pdf?tipe_laporan=${reportType}&tahun=${currentYear}`

        let filename = ''

        if (reportType === 'bulanan') {
            url += `&bulan=${monthNum}`
            filename = `laporan_bulanan_${monthLabel}_${currentYear}.pdf`
        } else if (reportType === 'guru') {
            // Ambil nomor guru dari tag atau input manual
            let no_lid = ''

            // Kalau user nge-tag orang
            if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                no_lid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0]
            }
            // Kalau manual nulis nomor
            else if (commandParts[2]) {
                no_lid = commandParts[2]
            }

            // bersihin format WA
            no_lid = no_lid.replace(/[@a-z.]/gi, '')

            if (!no_lid) {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    { text: 'Format salah.\nGunakan:\n#laporan guru @tag\natau\n#laporan guru 628xxxx' },
                    { quoted: msg },
                )
                return
            }

            url += `&no_lid=${no_lid}&bulan=${monthNum}`
            filename = `laporan_guru_${no_lid}_${monthLabel}_${currentYear}.pdf`
        }

        // Send processing message

        console.log('==============================================')
        console.log('[LAPORAN] Memulai proses pengambilan laporan')
        console.log('[INFO] URL      :', url)
        console.log('[INFO] Filename :', filename)
        console.log('==============================================')

        console.log('[STEP 1] Mengambil PDF dari API...')

        const response = await axios.get(url, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': api_key,
            },
            responseType: 'arraybuffer',
            timeout: 30000,
        })

        console.log('[STEP 2] Response diterima dari API')
        console.log('[INFO] Status Code:', response.status)

        if (response.status === 200) {
            console.log('[STEP 3] Convert PDF ke Base64...')

            const pdfBase64 = Buffer.from(response.data, 'binary').toString('base64')

            console.log('[INFO] Ukuran file base64:', pdfBase64.length)

            console.log('[STEP 4] Mengirim file ke WhatsApp...')

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

            console.log('==============================================')
            console.log('[SUCCESS] Laporan berhasil terkirim!')
            console.log('[INFO] File   :', filename)
            console.log('[INFO] Tujuan :', msg.key.remoteJid)
            console.log('==============================================')
        } else {
            console.log('==============================================')
            console.log('[ERROR] API mengembalikan status bukan 200')
            console.log('[ERROR] Status :', response.status)
            console.log('==============================================')

            await wa.sendMessage(
                msg.key.remoteJid,
                { text: 'Maaf, terjadi kesalahan saat mengambil laporan.' },
                { quoted: msg },
            )
        }
    } catch (error) {
        console.log('==============================================')
        console.log('[ERROR] Gagal saat memproses laporan')
        console.log('==============================================')

        if (error.response) {
            console.log('[ERROR] Status  :', error.response.status)
            console.log('[ERROR] Data    :', error.response.data)
        } else if (error.request) {
            console.log('[ERROR] Tidak ada response dari API')
            console.log('[ERROR] Request :', error.request)
        } else {
            console.log('[ERROR] Message :', error.message)
        }

        console.log('[ERROR] Stack Trace:')
        console.log(error.stack)

        console.log('==============================================')

        try {
            await wa.sendMessage(
                msg.key.remoteJid,
                { text: 'Maaf, terjadi kesalahan saat memproses permintaan laporan.' },
                { quoted: msg },
            )
        } catch (sendErr) {
            console.log('[ERROR] Gagal mengirim pesan error ke WhatsApp:', sendErr.message)
        }
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
    console.log('==============================================')
    console.log('[EVENT] messages.upsert diterima')
    console.log('[INFO] Type event:', m.type)
    console.log('[INFO] Total messages masuk:', m.messages.length)
    console.log('==============================================')

    // ===== FIX ANTI SPAM HISTORY =====

    // Hanya proses pesan baru (notify)
    if (m.type !== 'notify') {
        console.log('[SKIP] Bukan tipe notify, tidak diproses')
        return
    }

    const now = Math.floor(Date.now() / 1000)

    console.log('[INFO] Waktu server sekarang (unix):', now)

    const messages = m.messages.filter((msg) => {
        // Abaikan pesan dari diri sendiri
        if (msg.key.fromMe) {
            console.log('[SKIP] Pesan dari bot sendiri:', msg.key.id)
            return false
        }

        // Abaikan pesan lama berdasarkan timestamp
        const msgTime = msg.messageTimestamp ? Number(msg.messageTimestamp) : 0

        if (now - msgTime >= 60) {
            console.log('[SKIP] Pesan terlalu lama (history):', {
                id: msg.key.id,
                age: now - msgTime + ' detik',
            })
            return false
        }

        console.log('[ACCEPT] Pesan valid untuk diproses:', msg.key.id)
        return true
    })

    console.log('[INFO] Jumlah pesan setelah filter:', messages.length)

    if (messages.length === 0) {
        console.log('[INFO] Tidak ada pesan yang lolos filter, stop proses')
        return
    }

    // Auto read messages
    if (process.env.AUTO_READ_MESSAGES === 'true') {
        try {
            await wa.readMessages(messages.map((msg) => msg.key))
            console.log('[INFO] Marked as read:', messages.length, 'message(s)')
        } catch (error) {
            console.error('[ERROR] Gagal mark as read:', error)
        }
    }

    const messageTmp = await Promise.all(
        messages.map(async (msg) => {
            try {
                console.log('----------------------------------------------')
                console.log('[PROCESS] Mulai proses pesan')
                console.log('[DATA] Key      :', msg.key)
                console.log('[DATA] From     :', msg.key.remoteJid)

                const typeMessage = Object.keys(msg.message)[0]
                console.log('[DATA] Tipe msg :', typeMessage)

                if (msg?.status) {
                    msg.status = WAMessageStatus[msg?.status] ?? 'UNKNOWN'
                }

                // Handle image messages from groups
                if (typeMessage === 'imageMessage' && msg.key.remoteJid.endsWith('@g.us')) {
                    console.log('[ACTION] Detected imageMessage di grup')
                    await handleGroupImageMessage(wa, msg, sessionId)
                    console.log('[ACTION] handleGroupImageMessage selesai')
                }

                // Handle text commands from groups
                if (
                    msg.key.remoteJid.endsWith('@g.us') &&
                    (typeMessage === 'conversation' || typeMessage === 'extendedTextMessage')
                ) {
                    console.log('[ACTION] Detected text message di grup')

                    const handled = await handleGroupCommands(wa, msg, sessionId)

                    if (handled) {
                        console.log('[ACTION] Pesan diproses sebagai command, stop di sini')
                        return
                    } else {
                        console.log('[INFO] Pesan bukan command, lanjut proses normal')
                    }
                }

                // Proses file base64 untuk webhook
                if (
                    ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage'].includes(typeMessage) &&
                    process.env.APP_WEBHOOK_FILE_IN_BASE64 === 'true'
                ) {
                    console.log('[ACTION] Convert media ke base64 untuk webhook')

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
                            msg.message[typeMessage][field] =
                                convertToBase64(msg.message[typeMessage][field])
                        }
                    })

                    console.log('[INFO] Media berhasil diconvert base64')

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

                console.log('[PROCESS] Selesai proses pesan')
                return msg

            } catch (err) {
                console.error('[ERROR] Gagal proses pesan:', err)
                return {}
            }
        }),
    )

    console.log('==============================================')
    console.log('[WEBHOOK] Mengirim data ke webhook')
    console.log('[WEBHOOK] Total pesan dikirim:', messageTmp.length)
    console.log('==============================================')

    callWebhook(sessionId, 'MESSAGES_UPSERT', messageTmp)
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
