/**
 * Command Handler Module
 *
 * This module handles all command-related operations including:
 * - Processing group commands (#laporan, #jurnal)
 * - Command validation and authorization
 * - Command-specific business logic
 */

import axios from 'axios'
import { downloadMediaMessage } from 'baileys'
import {
    info,
    success,
    error,
    warning,
    command,
    api,
    apiCall,
    report,
    debug,
    separator,
} from '../utils/logger.js'

/**
 * Authorized phone numbers for command access
 * @type {Array<string>}
 */
const AUTHORIZED_NUMBERS = ['6285212870484', '6283853399847']

/**
 * Known commands that the bot recognizes
 * @type {Array<string>}
 */
const KNOWN_COMMANDS = ['#laporan', '#jurnal', '/menu', '/billing', '/today']

/**
 * Month name to number mapping for Indonesian months
 * @type {object}
 */
const MONTH_MAP = {
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

/**
 * API configuration for external services
 * @type {object}
 */
const API_CONFIG = {
    base_url: 'http://10.46.1.16:9998/api',
    api_key: 'whatsapp_bot_key_2024',
    timeout: 30000, // 30 seconds timeout
    max_retries: 3, // Maximum retry attempts
    retry_delay: 2000, // Delay between retries in ms
}

/**
 * Maximum image size in bytes (10MB)
 * @type {number}
 */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

/**
 * Allowed image MIME types
 * @type {Array<string>}
 */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

/**
 * Map class aliases to full class names
 *
 * @param {string} kelasInput - The input class name
 * @returns {string} The mapped class name
 */
const mapAliasKelas = (kelasInput) => {
    const text = kelasInput.toLowerCase()

    if (text.includes('olim')) {
        if (text.includes('mtk')) return 'Olimpiade - MTK'
        if (text.includes('indo')) return 'Olimpiade - Indo'
        if (text.includes('ipa')) return 'Olimpiade - IPA'
        if (text.includes('ips')) return 'Olimpiade - IPS'
        if (text.includes('inggris')) return 'Olimpiade - Inggris'
    }

    return kelasInput
}

/**
 * Validate image type and size
 *
 * @param {string} mimetype - The image MIME type
 * @param {number} size - The image size in bytes
 * @returns {object} Validation result with isValid and error message
 */
const validateImage = (mimetype, size) => {
    if (!ALLOWED_IMAGE_TYPES.includes(mimetype)) {
        return {
            isValid: false,
            error: `Format gambar tidak didukung. Gunakan: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
        }
    }

    if (size > MAX_IMAGE_SIZE) {
        return {
            isValid: false,
            error: `Ukuran gambar terlalu besar. Maksimum: ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`,
        }
    }

    return { isValid: true }
}

/**
 * Retry API call with exponential backoff
 *
 * @param {Function} apiCall - The API function to call
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delay - Initial delay between retries in ms
 * @returns {Promise<object>} API response
 */
const retryApiCall = async (apiCall, maxRetries = API_CONFIG.max_retries, delay = API_CONFIG.retry_delay) => {
    let lastError

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await apiCall()
        } catch (error) {
            lastError = error
            console.log(`[RETRY] Attempt ${attempt}/${maxRetries} failed:`, error.message)

            if (attempt < maxRetries) {
                const waitTime = delay * attempt // Exponential backoff
                console.log(`[RETRY] Waiting ${waitTime}ms before retry...`)
                await new Promise((resolve) => setTimeout(resolve, waitTime))
            }
        }
    }

    throw lastError
}

/**
 * Parse date string in DD-MM-YYYY format to YYYY-MM-DD
 *
 * @param {string} dateString - Date string in DD-MM-YYYY format
 * @returns {string|null} Date in YYYY-MM-DD format or null if invalid
 */
const parseDate = (dateString) => {
    const regex = /^(\d{2})-(\d{2})-(\d{4})$/
    if (!regex.test(dateString)) {
        return null
    }

    const [dd, mm, yyyy] = dateString.split('-')
    const date = new Date(`${yyyy}-${mm}-${dd}`)

    if (isNaN(date.getTime())) {
        return null
    }

    return `${yyyy}-${mm}-${dd}`
}

/**
 * Sanitize text input to prevent injection attacks
 *
 * @param {string} text - The text to sanitize
 * @returns {string} Sanitized text
 */
const sanitizeText = (text) => {
    if (!text) return ''
    return text
        .trim()
        .replace(/[<>]/g, '') // Remove potential HTML tags
        .replace(/['"]/g, '') // Remove quotes
        .substring(0, 500) // Limit length
}

/**
 * Check if a user is authorized to use commands
 * 
 * @param {string} sender - The sender's JID
 * @returns {boolean} True if authorized, false otherwise
 */
const isAuthorized = (sender) => {
    const phoneNumber = sender.replace(/[@s.whatsapp.net@g.us]/g, '')
    return AUTHORIZED_NUMBERS.includes(phoneNumber)
}

/**
 * Handle group commands
 * 
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 * @param {string} sessionId - The session ID
 * @returns {Promise<boolean>} True if command was handled, false otherwise
 */
const handleGroupCommands = async (wa, msg, sessionId) => {
    try {
        command('CommandHandler', 'Receiving new message in group', {
            sessionId,
            groupId: msg.key.remoteJid,
        })

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (!messageContent) {
            debug('CommandHandler', 'Empty message, skipping command handler', {
                sessionId,
            })
            return false
        }

        const text = messageContent.trim().toLowerCase()
        const command = text.split(' ')[0]

        debug('CommandHandler', 'Text and command detected', {
            sessionId,
            text,
            command,
        })

        if (!KNOWN_COMMANDS.includes(command)) {
            debug('CommandHandler', 'Unknown command, skipping', {
                sessionId,
                command,
            })
            return false
        }

        // Authorization check
        const sender = msg.key.participantAlt || msg.key.remoteJid
        const phoneNumber = sender.replace(/[@s.whatsapp.net@g.us]/g, '')

        debug('CommandHandler', 'Authorization check', {
            sessionId,
            sender,
            phoneNumber,
        })

        if (!isAuthorized(sender)) {
            warning('CommandHandler', 'Access denied for number', {
                sessionId,
                sender,
                phoneNumber,
            })

            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Anda tidak dapat menggunakan fitur ini.',
            })

            return true
        }

        success('CommandHandler', 'Access granted', {
            sessionId,
            sender,
        })

        switch (command) {
            case '/menu': {
                command('CommandHandler', 'Processing /menu command', {
                    sessionId,
                })

                try {
                    await handleMenuCommand(wa, msg)
                    success('CommandHandler', '/menu command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleMenuCommand failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '#laporan': {
                command('CommandHandler', 'Processing #laporan command', {
                    sessionId,
                })

                try {
                    await handleReportCommand(wa, msg)
                    success('CommandHandler', '#laporan command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleReportCommand failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '/billing': {
                command('CommandHandler', 'Processing /billing command', {
                    sessionId,
                })

                try {
                    await handleBillingCommand(wa, msg)
                    success('CommandHandler', '/billing command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleBillingCommand failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '/today': {
                command('CommandHandler', 'Processing /today command', {
                    sessionId,
                })

                try {
                    await handleTodayCommand(wa, msg)
                    success('CommandHandler', '/today command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleTodayCommand failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '#jurnal': {
                command('CommandHandler', 'Processing #jurnal command', {
                    sessionId,
                })

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

                        info('CommandHandler', 'Custom date detected', {
                            sessionId,
                            customDate: tanggalFinal,
                        })
                    }
                }

                // Check if there's a quoted message
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage

                debug('CommandHandler', 'Checking for quoted message', {
                    sessionId,
                    hasQuoted: !!quoted,
                })

                if (!quoted) {
                    warning('CommandHandler', '#jurnal without image reply', {
                        sessionId,
                    })

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
                    warning('CommandHandler', 'Quoted message is not an image', {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Pesan yang direply bukan gambar. Mohon reply pesan gambar.',
                    })

                    return true
                }

                debug('CommandHandler', 'Valid #jurnal command, proceeding to handleGroupImageMessage', {
                    sessionId,
                })

                try {
                    await handleGroupImageMessage(wa, msg, sessionId, tanggalFinal)
                    success('CommandHandler', '#jurnal command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleGroupImageMessage failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            default:
                debug('CommandHandler', 'Unknown command after switch', {
                    sessionId,
                    command,
                })
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

/**
 * Handle group image messages for journal entries
 * 
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 * @param {string} sessionId - The session ID
 * @param {string|null} tanggalCustom - Custom date in YYYY-MM-DD format
 */
const handleGroupImageMessage = async (wa, msg, sessionId, tanggalCustom = null) => {
    try {
        console.log('==============================================')
        console.log('[JURNAL] Memulai proses input jurnal')
        console.log('==============================================')

        let lid = ''
        let kelas = ''
        let materi = ''
        let tanggalKirim = tanggalCustom

        // Get LID with better error handling
        try {
            if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
                const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant
                lid = quotedParticipant.replace(/[@s.whatsapp.net]/g, '')
                console.log('[INFO] Mode QUOTE - LID dari quoted:', lid)
            } else {
                const participant = msg.key.participant || msg.key.remoteJid
                lid = participant.replace(/[@s.whatsapp.net]/g, '')
                console.log('[INFO] Mode NORMAL - LID dari pengirim:', lid)
            }

            if (!lid) {
                throw new Error('Tidak dapat mengidentifikasi pengirim')
            }
        } catch (error) {
            console.error('[ERROR] Gagal mendapatkan LID:', error)
            await wa.sendMessage(
                msg.key.remoteJid,
                { text: '❌ Gagal mengidentifikasi pengirim. Silakan coba lagi.' },
                { quoted: msg },
            )
            return
        }

        // Get media with validation
        let mediaMessage

        try {
            if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {
                console.log('[INFO] Mengambil media dari QUOTED message')

                const quoted = msg.message.extendedTextMessage.contextInfo.quotedMessage
                const imageData = quoted.imageMessage

                // Validate image type
                const validation = validateImage(imageData.mimetype, parseInt(imageData.fileLength) || 0)
                if (!validation.isValid) {
                    console.log('[ERROR] Validasi gambar gagal:', validation.error)
                    await wa.sendMessage(msg.key.remoteJid, { text: `❌ ${validation.error}` }, { quoted: msg })
                    return
                }

                const buffer = await downloadMediaMessage(
                    {
                        key: msg.key,
                        message: quoted,
                    },
                    'buffer',
                    {},
                    { reuploadRequest: wa.updateMediaMessage },
                )

                mediaMessage = {
                    mimetype: imageData.mimetype,
                    base64: buffer.toString('base64'),
                    size: buffer.length,
                }

                console.log('[INFO] Media berhasil diunduh:', {
                    type: mediaMessage.mimetype,
                    size: `${(mediaMessage.size / 1024).toFixed(2)} KB`,
                })
            } else if (msg.message?.imageMessage) {
                console.log('[INFO] Mengambil media dari pesan langsung')

                const imageData = msg.message.imageMessage

                // Validate image type
                const validation = validateImage(imageData.mimetype, parseInt(imageData.fileLength) || 0)
                if (!validation.isValid) {
                    console.log('[ERROR] Validasi gambar gagal:', validation.error)
                    await wa.sendMessage(msg.key.remoteJid, { text: `❌ ${validation.error}` }, { quoted: msg })
                    return
                }

                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { reuploadRequest: wa.updateMediaMessage },
                )

                mediaMessage = {
                    mimetype: imageData.mimetype,
                    base64: buffer.toString('base64'),
                    size: buffer.length,
                }

                console.log('[INFO] Media berhasil diunduh:', {
                    type: mediaMessage.mimetype,
                    size: `${(mediaMessage.size / 1024).toFixed(2)} KB`,
                })
            } else {
                throw new Error('Tidak ada gambar yang ditemukan dalam pesan')
            }
        } catch (error) {
            console.error('[ERROR] Gagal mengambil media:', error)
            await wa.sendMessage(
                msg.key.remoteJid,
                { text: '❌ Gagal mengambil gambar. Pastikan gambar valid dan coba lagi.' },
                { quoted: msg },
            )
            return
        }

        // Parse text with sanitization
        let text = ''

        if (msg.message?.imageMessage?.caption) {
            text = sanitizeText(msg.message.imageMessage.caption)
            console.log('[INFO] Parsing dari CAPTION:', text)
        } else if (msg.message?.extendedTextMessage?.text) {
            text = sanitizeText(msg.message.extendedTextMessage.text)
            console.log('[INFO] Parsing dari COMMAND:', text)
        }

        if (!text) {
            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: `❌ Format salah.

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

        const parts = text.split(' ').filter((part) => part.trim() !== '')

        // Mode COMMAND #JURNAL
        if (parts[0].toLowerCase() === '#jurnal') {
            console.log('[INFO] Mode COMMAND #jurnal terdeteksi')

            if (parts.length >= 2) {
                const parsedDate = parseDate(parts[1])
                if (parsedDate) {
                    tanggalKirim = parsedDate
                    kelas = parts[2] || ''
                    materi = parts.slice(3).join(' ')
                    console.log('[INFO] Tanggal custom:', tanggalKirim)
                } else {
                    kelas = parts[1] || ''
                    materi = parts.slice(2).join(' ')
                }
            } else {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    {
                        text: `❌ Format salah.

Gunakan:
#jurnal 7h matematika algoritma dasar

Atau dengan tanggal:
#jurnal 06-02-2026 7h matematika algoritma dasar`,
                    },
                    { quoted: msg },
                )
                return
            }
        }
        // Mode CAPTION LANGSUNG
        else {
            kelas = parts[0] || ''
            materi = parts.slice(1).join(' ')
        }

        kelas = sanitizeText(mapAliasKelas(kelas))
        materi = sanitizeText(materi)

        // Validate parsing result
        if (!kelas || !materi) {
            console.log('[ERROR] Format parsing gagal:', { kelas, materi })

            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: `❌ Format jurnal salah.

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

        // Default to today's date
        if (!tanggalKirim) {
            tanggalKirim = new Date().toISOString().split('T')[0]
        }

        console.log('[INFO] Hasil parsing final:')
        console.log('- LID    :', lid)
        console.log('- Kelas  :', kelas)
        console.log('- Materi :', materi)
        console.log('- Tanggal:', tanggalKirim)

        // Send to API with retry logic
        const data = {
            no_lid: lid,
            kelas: kelas,
            materi: materi,
            keterangan: 'Jurnal via WhatsApp Bot',
            foto: `data:${mediaMessage.mimetype};base64,${mediaMessage.base64}`,
            tanggal: tanggalKirim,
        }

        console.log('[INFO] Mengirim data ke API dengan retry logic...')

        try {
            const response = await retryApiCall(
                () =>
                    axios.post(`${API_CONFIG.base_url}/create_jurnal`, data, {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-Key': API_CONFIG.api_key,
                        },
                        timeout: API_CONFIG.timeout,
                    }),
                API_CONFIG.max_retries,
                API_CONFIG.retry_delay,
            )

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
                    { text: '❌ Gagal menyimpan jurnal. Mohon coba lagi.' },
                    { quoted: msg },
                )
            }
        } catch (apiError) {
            console.error('[ERROR] API call failed after retries:', apiError)

            let errorMessage = '❌ Terjadi kesalahan saat mengirim ke API.'

            if (apiError.response) {
                console.error('[ERROR] API Response:', {
                    status: apiError.response.status,
                    data: apiError.response.data,
                })
                errorMessage += `\nStatus: ${apiError.response.status}`
            } else if (apiError.request) {
                console.error('[ERROR] No response from API:', apiError.request)
                errorMessage += '\nTidak ada respons dari server API.'
            } else {
                console.error('[ERROR] API Error:', apiError.message)
                errorMessage += `\nError: ${apiError.message}`
            }

            await wa.sendMessage(msg.key.remoteJid, { text: errorMessage }, { quoted: msg })
        }
    } catch (error) {
        console.error('[ERROR] Exception handleGroupImageMessage:', error)
        console.error('[ERROR] Stack trace:', error.stack)

        await wa.sendMessage(
            msg.key.remoteJid,
            { text: '❌ Terjadi kesalahan sistem saat memproses jurnal.' },
            { quoted: msg },
        )
    }
}

/**
 * Handle menu command - displays available features for authorized users
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 */
const handleMenuCommand = async (wa, msg) => {
    try {
        console.log('[MENU] Menampilkan menu fitur')

        const menuMessage =
            `🤖 *MENU FITUR WHATSAPP BOT*\n\n` +
            `📋 *Fitur Tersedia:*\n\n` +
            `📊 *#laporan* - Mengambil laporan\n` +
            `   Format: #laporan [bulan]\n` +
            `   Contoh: #laporan februari\n` +
            `   Format: #laporan guru @tag\n` +
            `   Contoh: #laporan guru @628xxxx\n\n` +
            `💰 */billing* - Mengambil laporan billing bulanan\n` +
            `   Format: /billing [bulan] [tahun]\n` +
            `   Contoh: /billing februari 2026\n` +
            `   Contoh: /billing 2 2026\n` +
            `   Contoh: /billing februari\n\n` +
            `📅 */today* - Melihat siapa yang sudah mengisi jurnal hari ini\n` +
            `   Format: /today\n` +
            `   Menampilkan daftar guru yang sudah submit jurnal hari ini\n\n` +
            `📝 *#jurnal* - Input jurnal dengan gambar\n` +
            `   Format: #jurnal [tanggal] kelas materi\n` +
            `   Contoh: #jurnal 7h matematika algoritma dasar\n` +
            `   Contoh: #jurnal 06-02-2026 7h matematika algoritma dasar\n\n` +
            `📌 *Catatan:*\n` +
            `   - Gunakan format tanggal DD-MM-YYYY untuk tanggal custom\n` +
            `   - Reply gambar untuk input jurnal\n` +
            `   - Nama bulan: januari, februari, maret, dst.\n` +
            `   - Untuk billing, tahun default adalah tahun berjalan\n\n` +
            `⚠️ *Akses Terbatas*\n` +
            `   Fitur ini hanya dapat diakses oleh nomor terdaftar.`

        await wa.sendMessage(msg.key.remoteJid, {
            text: menuMessage,
        }, { quoted: msg })

        console.log('[SUCCESS] Menu berhasil ditampilkan')
    } catch (error) {
        console.error('[ERROR] Gagal menampilkan menu:', error)
        await wa.sendMessage(msg.key.remoteJid, {
            text: '❌ Terjadi kesalahan saat menampilkan menu.',
        }, { quoted: msg })
    }
}

/**
 * Handle report command
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 */
const handleReportCommand = async (wa, msg) => {
    try {
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (!messageContent.toLowerCase().startsWith('#laporan')) {
            return
        }

        const commandParts = messageContent.toLowerCase().split(' ')

        const currentYear = new Date().getFullYear()
        const currentMonth = new Date().getMonth() + 1

        // Default values
        let reportType = 'bulanan'
        let monthNum = currentMonth
        let monthLabel = Object.keys(MONTH_MAP).find((k) => MONTH_MAP[k] === currentMonth)

        // Parse command
        if (commandParts.length === 2 && MONTH_MAP[commandParts[1]]) {
            monthNum = MONTH_MAP[commandParts[1]]
            monthLabel = commandParts[1]
        } else if (commandParts.length >= 3 && commandParts[1] === 'bulan' && MONTH_MAP[commandParts[2]]) {
            monthNum = MONTH_MAP[commandParts[2]]
            monthLabel = commandParts[2]
        } else if (commandParts.length >= 3 && commandParts[1] === 'bulanan' && MONTH_MAP[commandParts[2]]) {
            monthNum = MONTH_MAP[commandParts[2]]
            monthLabel = commandParts[2]
        } else if (commandParts[1] === 'guru') {
            reportType = 'guru'
        }

        // Build URL and filename
        let url = `${API_CONFIG.base_url}/get_laporan_pdf?tipe_laporan=${reportType}&tahun=${currentYear}`
        let filename = ''

        if (reportType === 'bulanan') {
            url += `&bulan=${monthNum}`
            filename = `laporan_bulanan_${monthLabel}_${currentYear}.pdf`
        } else if (reportType === 'guru') {
            let no_lid = ''

            if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                no_lid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0]
            } else if (commandParts[2]) {
                no_lid = commandParts[2]
            }

            no_lid = no_lid.replace(/[@a-z.]/gi, '')

            if (!no_lid) {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    { text: '❌ Format salah.\nGunakan:\n#laporan guru @tag\natau\n#laporan guru 628xxxx' },
                    { quoted: msg },
                )
                return
            }

            url += `&no_lid=${no_lid}&bulan=${monthNum}`
            filename = `laporan_guru_${no_lid}_${monthLabel}_${currentYear}.pdf`
        }

        console.log('==============================================')
        console.log('[LAPORAN] Memulai proses pengambilan laporan')
        console.log('[INFO] URL      :', url)
        console.log('[INFO] Filename :', filename)
        console.log('==============================================')

        console.log('[STEP 1] Mengambil PDF dari API dengan retry logic...')

        const response = await retryApiCall(
            () =>
                axios.get(url, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': API_CONFIG.api_key,
                    },
                    responseType: 'arraybuffer',
                    timeout: API_CONFIG.timeout,
                }),
            API_CONFIG.max_retries,
            API_CONFIG.retry_delay,
        )

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
                { text: '❌ Maaf, terjadi kesalahan saat mengambil laporan.' },
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
                { text: '❌ Maaf, terjadi kesalahan saat memproses permintaan laporan.' },
                { quoted: msg },
            )
        } catch (sendErr) {
            console.log('[ERROR] Gagal mengirim pesan error ke WhatsApp:', sendErr.message)
        }
    }
}

/**
 * Handle billing command - retrieves monthly billing PDF report
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 */
const handleBillingCommand = async (wa, msg) => {
    try {
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (!messageContent.toLowerCase().startsWith('/billing')) {
            return
        }

        const commandParts = messageContent.toLowerCase().split(' ')

        const currentYear = new Date().getFullYear()
        const currentMonth = new Date().getMonth() + 1

        // Default values
        let monthNum = currentMonth
        let yearNum = currentYear
        let monthLabel = Object.keys(MONTH_MAP).find((k) => MONTH_MAP[k] === currentMonth)

        // Parse command
        // Format: /billing [bulan] [tahun]
        // Example: /billing februari 2026
        // Example: /billing 2 2026
        
        if (commandParts.length >= 2) {
            // Check if first parameter is month name or number
            if (MONTH_MAP[commandParts[1]]) {
                monthNum = MONTH_MAP[commandParts[1]]
                monthLabel = commandParts[1]
            } else {
                // Try to parse as number
                const parsedMonth = parseInt(commandParts[1])
                if (!isNaN(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) {
                    monthNum = parsedMonth
                    monthLabel = Object.keys(MONTH_MAP).find((k) => MONTH_MAP[k] === parsedMonth)
                } else {
                    await wa.sendMessage(
                        msg.key.remoteJid,
                        { 
                            text: '❌ Format salah.\n\nGunakan:\n/billing [bulan] [tahun]\n\nContoh:\n/billing februari 2026\n/billing 2 2026\n/billing februari\n\nNama bulan: januari, februari, maret, dst.' 
                        },
                        { quoted: msg },
                    )
                    return
                }
            }
        }

        if (commandParts.length >= 3) {
            // Parse year
            const parsedYear = parseInt(commandParts[2])
            if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) {
                yearNum = parsedYear
            } else {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    { 
                        text: '❌ Tahun tidak valid.\n\nGunakan tahun antara 2000-2100.\n\nContoh:\n/billing februari 2026' 
                    },
                    { quoted: msg },
                )
                return
            }
        }

        // Build URL and filename
        const url = `${API_CONFIG.base_url}/get_billing_pdf?bulan=${monthNum}&tahun=${yearNum}`
        const filename = `billing_bulanan_${monthLabel}_${yearNum}.pdf`

        console.log('==============================================')
        console.log('[BILLING] Memulai proses pengambilan billing')
        console.log('[INFO] URL      :', url)
        console.log('[INFO] Filename :', filename)
        console.log('[INFO] Bulan    :', monthNum, `(${monthLabel})`)
        console.log('[INFO] Tahun   :', yearNum)
        console.log('==============================================')

        console.log('[STEP 1] Mengambil PDF dari API dengan retry logic...')

        const response = await retryApiCall(
            () =>
                axios.get(url, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': API_CONFIG.api_key,
                    },
                    responseType: 'arraybuffer',
                    timeout: API_CONFIG.timeout,
                }),
            API_CONFIG.max_retries,
            API_CONFIG.retry_delay,
        )

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
                    caption: `Berikut adalah laporan billing bulanan ${monthLabel} ${yearNum}`,
                },
                { quoted: msg },
            )

            console.log('==============================================')
            console.log('[SUCCESS] Billing berhasil terkirim!')
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
                { text: '❌ Maaf, terjadi kesalahan saat mengambil laporan billing.' },
                { quoted: msg },
            )
        }
    } catch (error) {
        console.log('==============================================')
        console.log('[ERROR] Gagal saat memproses billing')
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
                { text: '❌ Maaf, terjadi kesalahan saat memproses permintaan billing.' },
                { quoted: msg },
            )
        } catch (sendErr) {
            console.log('[ERROR] Gagal mengirim pesan error ke WhatsApp:', sendErr.message)
        }
    }
}

/**
 * Handle today command - retrieves list of teachers who have submitted journals today
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 */
const handleTodayCommand = async (wa, msg) => {
    try {
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (!messageContent.toLowerCase().startsWith('/today')) {
            return
        }

        // Get today's date in YYYY-MM-DD format
        const today = new Date().toISOString().split('T')[0]

        console.log('==============================================')
        console.log('[TODAY] Memulai proses pengambilan jurnal hari ini')
        console.log('[INFO] Tanggal:', today)
        console.log('==============================================')

        console.log('[STEP 1] Mengambil data jurnal dari API dengan retry logic...')

        const response = await retryApiCall(
            () =>
                axios.get(`${API_CONFIG.base_url}/get_jurnal_today`, {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': API_CONFIG.api_key,
                    },
                    timeout: API_CONFIG.timeout,
                }),
            API_CONFIG.max_retries,
            API_CONFIG.retry_delay,
        )

        console.log('[STEP 2] Response diterima dari API')
        console.log('[INFO] Status Code:', response.status)

        if (response.status === 200 && response.data) {
            console.log('[STEP 3] Memformat data jurnal...')

            const jurnalData = response.data.data || []
            const totalJurnal = jurnalData.length

            console.log('[INFO] Total jurnal hari ini:', totalJurnal)

            if (totalJurnal === 0) {
                const noDataMessage =
                    `📊 *LAPORAN JURNAL HARI INI*\n\n` +
                    `📅 Tanggal: ${today}\n\n` +
                    `❌ *Belum ada jurnal yang diinput hari ini.*\n\n` +
                    `💡 Gunakan #jurnal untuk menginput jurnal.`

                await wa.sendMessage(msg.key.remoteJid, { text: noDataMessage }, { quoted: msg })

                console.log('[SUCCESS] Pesan "belum ada jurnal" berhasil dikirim')
            } else {
                // Format the journal list
                let jurnalList = `📊 *LAPORAN JURNAL HARI INI*\n\n`
                jurnalList += `📅 Tanggal: ${today}\n`
                jurnalList += `📝 Total: ${totalJurnal} jurnal\n\n`
                jurnalList += `✅ *Guru yang sudah mengisi:*\n\n`

                jurnalData.forEach((jurnal, index) => {
                    const num = (index + 1).toString().padStart(2, '0')
                    jurnalList += `${num}. 👨‍🏫 ${jurnal.nama_guru}\n`
                    jurnalList += `   🏫 Kelas: ${jurnal.kelas}\n`
                    jurnalList += `   📚 Materi: ${jurnal.materi}\n`
                    jurnalList += `   ⏰ Waktu: ${jurnal.waktu_input || '-'}\n\n`
                })

                jurnalList += `📌 *Catatan:*\n`
                jurnalList += `   - Data diambil secara real-time dari sistem\n`
                jurnalList += `   - Waktu input menunjukkan kapan jurnal disubmit\n\n`
                jurnalList += `💡 Gunakan #jurnal untuk menginput jurnal.`

                await wa.sendMessage(msg.key.remoteJid, { text: jurnalList }, { quoted: msg })

                console.log('[SUCCESS] Daftar jurnal hari ini berhasil dikirim')
            }
        } else {
            console.log('==============================================')
            console.log('[ERROR] API mengembalikan status bukan 200')
            console.log('[ERROR] Status :', response.status)
            console.log('==============================================')

            await wa.sendMessage(
                msg.key.remoteJid,
                { text: '❌ Maaf, terjadi kesalahan saat mengambil data jurnal hari ini.' },
                { quoted: msg },
            )
        }
    } catch (error) {
        console.log('==============================================')
        console.log('[ERROR] Gagal saat memproses perintah /today')
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
                { text: '❌ Maaf, terjadi kesalahan saat memproses permintaan jurnal hari ini.' },
                { quoted: msg },
            )
        } catch (sendErr) {
            console.log('[ERROR] Gagal mengirim pesan error ke WhatsApp:', sendErr.message)
        }
    }
}

export {
    handleGroupCommands,
    handleGroupImageMessage,
    handleReportCommand,
    handleMenuCommand,
    handleBillingCommand,
    handleTodayCommand,
    mapAliasKelas,
    isAuthorized,
}
