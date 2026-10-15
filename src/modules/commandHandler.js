/**
 * Command Handler Module
 *
 * This module handles all command-related operations including:
 * - Processing group commands (#laporan, #jurnal, #jurnal-daring, #ekstra)
 * - Command validation and authorization
 * - Command-specific business logic
 * - Metode pembelajaran: luring (default) atau daring
 * - Jenis jurnal: akademik (default) atau non_akademik
 */

import axios from 'axios'
import { downloadMediaMessage } from 'baileys'
import NodeCache from 'node-cache'
import { info, success, error, warning, command, api, apiCall, report, debug, separator } from '../utils/logger.js'
import fs from 'fs'
import { generateVoiceNote } from '../utils/tts.js'
import { journalQueue, JournalStatus } from './journalQueue.js'

/**
 * Sentinel returned by handleGroupImageMessage when the sender cannot be resolved
 * (e.g. Baileys delivered a fresh upsert without key.participant yet). whatsapp.js
 * uses this to retry processing after a short delay instead of failing immediately.
 * @type {string}
 */
const SENDER_UNRESOLVED = 'SENDER_UNRESOLVED'

/**
 * Authorized phone numbers for command access
 * Can be configured via AUTHORIZED_NUMBERS env variable (comma-separated)
 * Falls back to hardcoded defaults if not set
 * @type {Array<string>}
 */
const AUTHORIZED_NUMBERS = process.env.AUTHORIZED_NUMBERS
    ? process.env.AUTHORIZED_NUMBERS.split(',').map((n) => n.trim())
    : ['6285212870484', '6283853399847']

/**
 * Known commands that the bot recognizes
 * @type {Array<string>}
 */
const KNOWN_COMMANDS = [
    '#laporan',
    '#jurnal',
    '#jurnal-daring',
    '#ekstra',
    '#jurnal-tka',
    '#jurnal-tka-daring',
    '#daftar',
    '/menu',
    '/billing',
    '/today',
    '/today-tka',
    '/rank',
    '/rank-tka',
]

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
 * Reads from environment variables first, falls back to hardcoded defaults
 * @type {object}
 */
const API_CONFIG = {
    base_url: process.env.API_BASE_URL || 'http://sim-mtsn.test/api',
    api_key: process.env.API_KEY || 'whatsapp_bot_key_2024',
    timeout: parseInt(process.env.API_TIMEOUT) || 30000, // 30 seconds timeout
    max_retries: parseInt(process.env.API_MAX_RETRIES) || 3, // Maximum retry attempts
    retry_delay: parseInt(process.env.API_RETRY_DELAY) || 2000, // Delay between retries in ms
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
 * Extract phone number from a JID (WhatsApp ID)
 * Properly handles both user JIDs (xxx@s.whatsapp.net) and group JIDs (xxx@g.us)
 * For group JIDs, returns the raw numeric part (which is the group ID, not a phone number)
 *
 * @param {string} jid - The JID string to extract from
 * @returns {string} The extracted number portion
 */
const extractPhoneNumber = (jid) => {
    if (!jid) return ''
    // Split at @ and take the first part (the number)
    // s.whatsapp.net = personal number, g.us = group ID, lid = linked ID
    // Strip device suffix (:0) from multi-device linked JIDs (e.g. 62812:0@s.whatsapp.net)
    return jid.split('@')[0].split(':')[0]
}

/**
 * Mask middle digits of phone number/nol_id for privacy
 * Example: 628123456789 → 628******789
 */
const maskPhoneNumber = (number) => {
    if (!number) return ''
    const digits = number.replace(/\D/g, '')
    if (digits.length < 6) return number
    const first = digits.slice(0, 3)
    const last = digits.slice(-4)
    const masked = ''.padStart(Math.max(0, digits.length - 8), '*')
    return `${first}${masked}${last}`
}

/**
 * Determine if a JID is a personal WhatsApp number (not a group)
 *
 * @param {string} jid - The JID to check
 * @returns {boolean} True if it's a personal number JID
 */
const isPersonalJid = (jid) => {
    if (!jid) return false
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
}

/**
 * Resolve phone-number JID to LID JID using Baileys lidMapping or contacts store
 */
const resolvePnToLid = async (wa, pnJid = '') => {
    if (!pnJid || !pnJid.endsWith('@s.whatsapp.net')) return pnJid
    try {
        const lidMapping = wa?.signalRepository?.lidMapping
        if (lidMapping && typeof lidMapping.getLIDForPN === 'function') {
            const lid = await lidMapping.getLIDForPN(pnJid)
            if (lid) return lid
        }
    } catch (err) {
        warning('CommandHandler', 'Baileys PN-to-LID mapping failed', { pnJid, error: err.message })
    }
    try {
        const contacts = wa?.store?.contacts
        if (contacts) {
            for (const [jidKey, contact] of contacts) {
                if (contact?.id === pnJid) return contact.lid || jidKey
            }
        }
    } catch (err) {
        warning('CommandHandler', 'Store PN-to-LID lookup failed', { pnJid, error: err.message })
    }
    return pnJid
}

/**
 * Extract both no_lid and no_hp from a mentioned JID
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {string} mentionedJidRaw - Raw JID from contextInfo
 * @returns {Promise<{no_lid: string, no_hp: string}>}
 */
const extractNolidAndPhone = async (wa, mentionedJidRaw) => {
    if (!mentionedJidRaw) return { no_lid: '', no_hp: '' }
    const lidKnown = mentionedJidRaw.endsWith('@lid')
    const pnKnown = mentionedJidRaw.endsWith('@s.whatsapp.net')
    if (lidKnown && !pnKnown) {
        const lid = extractPhoneNumber(mentionedJidRaw)
        const resolved = await resolveLidToPn(wa, mentionedJidRaw)
        const phone = extractPhoneNumber(resolved)
        return { no_lid: lid, no_hp: phone && phone !== lid ? phone : phone }
    }
    if (pnKnown) {
        const phone = extractPhoneNumber(mentionedJidRaw)
        const resolved = await resolvePnToLid(wa, mentionedJidRaw)
        const lid = extractPhoneNumber(resolved)
        return { no_lid: lid, no_hp: phone }
    }
    return { no_lid: '', no_hp: '' }
}

/**
 * Determine if a message was sent by the bot's own WhatsApp account.
 * Baileys marks own messages with key.fromMe, and on some devices the
 * participant resolves to the account's own number in remoteJid.
 *
 * @param {object} msg - The message object
 * @returns {boolean} True if the message appears to be from the bot itself
 */
const thisMessageIsFromSelf = (msg) => {
    if (!msg?.key) return false
    // Own messages are explicitly flagged by Baileys; only treat that as self.
    return msg.key.fromMe === true
}

/**
 * Extract the sender's LID for a message sent by the bot's own account.
 * Prefers key.participant; participantAlt may hold the phone-number JID for
 * linked devices; remoteJid is only valid outside groups.
 *
 * @param {object} msg - The message object
 * @returns {string} The extracted LID
 */
const selfSenderLid = (msg) => {
    if (msg?.key?.participant) return extractPhoneNumber(msg.key.participant)
    if (msg?.key?.participantAlt) return extractPhoneNumber(msg.key.participantAlt)
    if (msg?.key?.remoteJid && isPersonalJid(msg.key.remoteJid)) return extractPhoneNumber(msg.key.remoteJid)
    return ''
}

/**
 * Resolve a LID JID (e.g. `123456789@lid`) to a phone-number JID (e.g.
 * `62812...@s.whatsapp.net`).
 *
 * Priority path:
 * 1. Baileys socket's on-wire LID mapping resolver, if reachable (`wa.signalRepository`).
 *    This is the "official" mapping performed by Baileys during handling.
 * 2. Reverse lookup in the session store's contacts map, which stores
 *    `contact.lid` -> `contact.id` pairs (available even when the socket's
 *    private resolver is not exposed).
 *
 * Returns the resolved JID, or the input unchanged when no mapping is known.
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {string} jid - The JID to resolve
 * @returns {Promise<string>} The JID with a @s.whatsapp.net number encoded, or the input if unknown
 */
const resolveLidToPn = async (wa, jid = '') => {
    if (!jid || !jid.endsWith('@lid')) return jid

    try {
        // Official path: reuse Baileys' internal signal LID mapping if exposed on the socket.
        const lidMapping = wa?.signalRepository?.lidMapping
        if (lidMapping && typeof lidMapping.getPNForLID === 'function') {
            const pn = await lidMapping.getPNForLID(jid)
            if (pn) return pn
        }
    } catch (err) {
        warning('CommandHandler', 'Baileys LID mapping resolver failed, falling back to store', {
            lid: jid,
            error: err.message,
        })
    }

    try {
        const contacts = wa?.store?.contacts
        if (contacts) {
            for (const [jidKey, contact] of contacts) {
                if (contact?.lid === jid) {
                    const pn = contact.id || jidKey
                    return pn.endsWith('@lid') ? pn : `${pn.split('@')[0]}@s.whatsapp.net`
                }
            }
        }
    } catch (err) {
        warning('CommandHandler', 'Store LID-to-PN resolution failed', {
            lid: jid,
            error: err.message,
        })
    }

    return jid
}

/**
 * Normalize a sender JID (which may be a phone-number JID, `@lid` JID, or
 * plain number) to a clean phone-number string.
 *
 * Chain: resolve `@lid` → PN via official/store resolver, then `extractPhoneNumber`.
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {string} senderJid - Raw sender JID (e.g. `62812@s.whatsapp.net` or `123@lid` or `62812`)
 * @returns {Promise<string>} Clean phone number string
 */
const normalizeLidNumber = async (wa, senderJid = '') => {
    if (!senderJid) return ''
    const resolved = await resolveLidToPn(wa, senderJid)
    return extractPhoneNumber(resolved)
}

/**
 * Resolve the sender's LID by looking up the message in the session store.
 * Baileys may deliver a live message with key.participant undefined on the first
 * upsert, but the store can hold the fully-populated message once processed.
 * The returned value is re-resolved through the LID→PN mapping when the stored
 * participant is a `@lid` JID.
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 * @returns {Promise<string>} The resolved phone number (LID), or empty string if it cannot be determined
 */
const resolveSenderFromStore = async (wa, msg = {}) => {
    const jid = msg?.key?.remoteJid
    const messageId = msg?.key?.id
    if (!jid || !messageId || !wa?.store) return ''

    try {
        // Refetch the latest object from store: it may have been merged (Task 5)
        // with key.participant populated after the first upsert had it undefined.
        const stored = await wa.store.loadMessages(jid, messageId)
        if (stored && stored.length > 0) {
            const key = stored[0]?.key || {}
            const candidates = [key.participant, key.participantAlt, key.fromMe && key.remoteJid ? key.remoteJid : '']
            for (const candidate of candidates) {
                if (!candidate) continue
                const resolved = await resolveLidToPn(wa, candidate)
                const number = extractPhoneNumber(resolved)
                if (number) return number
            }
        }
    } catch (err) {
        warning('CommandHandler', 'Store-based sender resolution failed', {
            jid,
            messageId,
            error: err.message,
        })
    }

    return ''
}

/**
 * Check if a user is authorized to use commands
 *
 * @param {string} sender - The sender's JID
 * @returns {boolean} True if authorized, false otherwise
 */
const isAuthorized = (sender) => {
    const phoneNumber = extractPhoneNumber(sender)
    return AUTHORIZED_NUMBERS.includes(phoneNumber)
}

/**
 * Pending daftar cache — stores pending #daftar confirmations.
 * Key: `${groupJid}:${senderJid}`, Value: { guru_id, nama, no_lid_baru, no_lid_lama, expiresAt, sessionId, groupJid }
 * TTL 5 minutes.
 */
/**
 * Pending daftar cache — stores pending #daftar confirmations.
 * Key: `${groupJid}:${senderJid}`, Value: { guru_id, nama, no_lid_baru, no_lid_lama, expiresAt, sessionId, groupJid }
 * TTL 5 minutes.
 */
const daftarCache = new NodeCache({ stdTTL: 300, checkperiod: 60 })

/**
 * Handle #daftar command — register/update guru.no_lid via SIM API
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 * @param {string} sessionId - The session ID
 */
const handleDaftarCommand = async (wa, msg, sessionId) => {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim()
        const parts = text.split(' ').filter((p) => p.trim() !== '')

        // parts[0] = '#daftar', parts[1..] = nama / guru_id
        const args = parts.slice(1).filter((p) => !p.startsWith('@'))

        const mentionedJid =
            msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
            msg.message?.imageMessage?.contextInfo?.mentionedJid
        if (!mentionedJid || mentionedJid.length === 0) {
            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Format: #daftar Nama @mention\nContoh: #daftar Budi Santoso @628123456789',
            })
            return
        }
        const { no_lid: rawLidBaru, no_hp: rawHpBaru } = await extractNolidAndPhone(wa, mentionedJid[0])
        if (!rawLidBaru) {
            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Format: #daftar Nama @mention\nContoh: #daftar Budi Santoso @628123456789',
            })
            return
        }
        const noLidBaru = rawLidBaru
        const noHpBaru = rawHpBaru || rawLidBaru

        // Fallback by ID: #daftar 15 @62812xxxx
        let guruId = null
        let nama = null

        if (args.length > 0 && /^\d+$/.test(args[0])) {
            guruId = args[0]
        } else {
            nama = args.join(' ')
        }

        if (!guruId && (!nama || nama.length < 2)) {
            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Format: #daftar Nama @mention\nContoh: #daftar Budi Santoso @628123456789',
            })
            return
        }

        // Search guru if not by ID
        let guru = null
        if (!guruId) {
            const searchUrl = `${API_CONFIG.base_url}/search_guru?nama=${encodeURIComponent(nama)}`
            const searchRes = await axios.get(searchUrl, {
                headers: { 'X-API-Key': API_CONFIG.api_key },
                timeout: API_CONFIG.timeout,
            })

            const results = searchRes.data?.data || []

            if (results.length === 0) {
                await wa.sendMessage(msg.key.remoteJid, {
                    text: `Guru '${nama}' tidak ditemukan`,
                })
                return
            }

            if (results.length > 1) {
                let listMsg = `Ditemukan ${results.length} guru:\n`
                results.forEach((g, i) => {
                    listMsg += `${i + 1}. ${g.nama} (id ${g.id}) — no_lid ${maskPhoneNumber(g.no_lid) || '-'}\n`
                })
                listMsg += `\nBalas angka 1-${results.length} atau ketik #daftar ${results[0].id} @${noLidBaru} untuk pilih langsung`

                // Store pending list for numeric reply
                const senderJidRaw = msg.key.participant || msg.key.remoteJid
                const senderJid = senderJidRaw ? await normalizeLidNumber(wa, senderJidRaw) : ''
                const cacheKey = `${msg.key.remoteJid}:${senderJid}`
                daftarCache.set(cacheKey, {
                    type: 'list',
                    results,
                    no_lid_baru: noLidBaru,
                    no_hp_baru: noHpBaru,
                    expiresAt: Date.now() + 5 * 60 * 1000,
                    sessionId,
                    groupJid: msg.key.remoteJid,
                })

                await wa.sendMessage(msg.key.remoteJid, { text: listMsg })
                return
            }

            guru = results[0]
            guruId = guru.id
        } else {
            // Fallback by ID: #daftar 15 @62812xxxx — fetch guru data for the confirmation display
            const searchRes = await axios.get(`${API_CONFIG.base_url}/search_guru`, {
                params: { id: guruId },
                headers: { 'X-API-Key': API_CONFIG.api_key },
                timeout: API_CONFIG.timeout,
            })

            const found = (searchRes.data?.data || [])[0]
            if (!found) {
                await wa.sendMessage(msg.key.remoteJid, {
                    text: `Guru dengan id ${guruId} tidak ditemukan`,
                })
                return
            }

            guru = found
            guruId = found.id
        }

        const noLidClean = noLidBaru.replace(/\D/g, '')
        const hpClean = (noHpBaru || '').replace(/\D/g, '')

        // Store pending confirmation
        const senderJidRaw = msg.key.participant || msg.key.remoteJid
        const senderJid = senderJidRaw ? await normalizeLidNumber(wa, senderJidRaw) : ''
        const cacheKey = `${msg.key.remoteJid}:${senderJid}`
        daftarCache.set(cacheKey, {
            type: 'confirm',
            guru_id: parseInt(guruId),
            nama: guru.nama,
            no_lid_baru: noLidClean,
            no_hp_baru: hpClean,
            no_lid_lama: guru.no_lid || null,
            expiresAt: Date.now() + 5 * 60 * 1000,
            sessionId,
            groupJid: msg.key.remoteJid,
        })

        // Send confirmation with masked numbers
        const lidMasked = maskPhoneNumber(noLidClean)
        const hpMasked = maskPhoneNumber(hpClean)
        await wa.sendMessage(msg.key.remoteJid, {
            text: `Konfirmasi pendaftaran:\nGuru: ${guru.nama} (id ${guruId})\nNo. baru (tersensor): ${lidMasked}\nNo. hp (tersensor): ${hpMasked}${guru.no_lid ? `\nNo. lama: ${maskPhoneNumber(guru.no_lid)}` : ''}\n\nBenar? Balas ya / tidak (5 menit)`,
        })
    } catch (err) {
        error('CommandHandler', 'handleDaftarCommand failed', { error: err.message })
        await wa.sendMessage(msg.key.remoteJid, {
            text: 'Terjadi kesalahan saat memproses pendaftaran.',
        })
    }
}

/**
 * Check if a message is a pending daftar confirmation (ya/tidak/number)
 * Called from handleMessageUpsert before handleGroupCommands
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 * @param {string} sessionId - The session ID
 * @returns {Promise<boolean>} True if handled as confirmation
 */
const checkDaftarConfirmation = async (wa, msg, sessionId, senderJid = '') => {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase()

        // Only process short replies
        if (!['ya', 'tidak', 'y', 't'].includes(text) && !/^\d+$/.test(text)) {
            return false
        }

        // Gunakan senderJid ternormalisasi (dari whatsapp.js), fallback resolve di sini
        if (!senderJid) {
            const rawSender = msg.key.participant || msg.key.remoteJid
            senderJid = rawSender ? await normalizeLidNumber(wa, rawSender) : ''
        }

        // Otorisasi: hanya AUTHORIZED_NUMBERS yang boleh konfirmasi #daftar (spec §4.5)
        if (!isAuthorized(senderJid)) {
            return false
        }

        const cacheKey = `${msg.key.remoteJid}:${senderJid}`
        const pending = daftarCache.get(cacheKey)

        if (!pending) return false

        // Check expiry
        if (Date.now() > pending.expiresAt) {
            daftarCache.del(cacheKey)
            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Konfirmasi kadaluarsa, ulangi #daftar',
            })
            return true
        }

        // Handle numeric reply (list selection)
        if (/^\d+$/.test(text) && pending.type === 'list') {
            const idx = parseInt(text) - 1
            if (idx < 0 || idx >= pending.results.length) {
                await wa.sendMessage(msg.key.remoteJid, {
                    text: `Pilihan tidak valid. Balas angka 1-${pending.results.length}`,
                })
                return true
            }

            const selected = pending.results[idx]
            pending.type = 'confirm'
            pending.guru_id = selected.id
            pending.nama = selected.nama
            pending.no_lid_lama = selected.no_lid || null
            pending.expiresAt = Date.now() + 5 * 60 * 1000
            daftarCache.set(cacheKey, pending)

            await wa.sendMessage(msg.key.remoteJid, {
                text: `Konfirmasi pendaftaran:\nGuru: ${selected.nama} (id ${selected.id})\nNo. baru (tersensor): ${maskPhoneNumber(pending.no_lid_baru)}\nNo. hp (tersensor): ${maskPhoneNumber(pending.no_hp_baru || '')}${selected.no_lid ? `\nNo. lama: ${maskPhoneNumber(selected.no_lid)}` : ''}\n\nBenar? Balas ya / tidak (5 menit)`,
            })
            return true
        }

        // Handle ya/tidak
        if (text === 'tidak' || text === 't') {
            daftarCache.del(cacheKey)
            await wa.sendMessage(msg.key.remoteJid, { text: 'Dibatalkan.' })
            return true
        }

        // ya / y
        const noLidClean = pending.no_lid_baru.replace(/\D/g, '')
        const noHpRaw = (pending.no_hp_baru || '').replace(/\D/g, '')
        // Fallback: bila mapping LID→PN tidak ditemukan, kirim no_lid yang sama
        const noHpClean = noHpRaw.length >= 8 ? noHpRaw : noLidClean

        try {
            const res = await axios.post(
                `${API_CONFIG.base_url}/update_guru_whatsapp`,
                { guru_id: pending.guru_id, no_lid: noLidClean, no_hp: noHpClean },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-Key': API_CONFIG.api_key,
                    },
                    timeout: API_CONFIG.timeout,
                }
            )

            if (res.data?.status === 'success') {
                await wa.sendMessage(msg.key.remoteJid, {
                    text: `✅ Guru ${pending.nama} berhasil didaftarkan. No: ${maskPhoneNumber(noLidClean)}`,
                })
            } else {
                await wa.sendMessage(msg.key.remoteJid, {
                    text: `❌ Gagal: ${res.data?.message || 'Unknown error'}`,
                })
            }
        } catch (apiErr) {
            const errMsg = apiErr.response?.data?.message || apiErr.message
            await wa.sendMessage(msg.key.remoteJid, {
                text: `❌ Gagal: ${errMsg}`,
            })
        }

        daftarCache.del(cacheKey)
        return true
    } catch (err) {
        error('CommandHandler', 'checkDaftarConfirmation failed', { error: err.message })
        return false
    }
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

        // Extract text from all possible message types:
        // - conversation: plain text messages
        // - extendedTextMessage: text with links/mentions/quotes
        // - imageMessage.caption: images with caption (like "#jurnal 8K matematika" sent with a photo)
        const messageContent =
            msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ''

        if (!messageContent) {
            debug('CommandHandler', 'Empty message, skipping command handler', {
                sessionId,
            })
            return false
        }

        const text = messageContent.trim().toLowerCase()
        const cmd = text.split(' ')[0]

        debug('CommandHandler', 'Text and command detected', {
            sessionId,
            text,
            command: cmd,
        })

        if (!KNOWN_COMMANDS.includes(cmd)) {
            debug('CommandHandler', 'Unknown command, skipping', {
                sessionId,
                command: cmd,
            })
            return false
        }

        // Authorization check - use participant (actual sender) not remoteJid (group ID)
        // Use the same robust sender resolution as handleGroupImageMessage
        let senderJid = msg.key.participant
        if (!senderJid && msg.message?.extendedTextMessage?.contextInfo?.participant) {
            senderJid = msg.message.extendedTextMessage.contextInfo.participant
        }
        if (!senderJid && msg.message?.imageMessage?.contextInfo?.participant) {
            senderJid = msg.message.imageMessage.contextInfo.participant
        }
        if (!senderJid && msg.message?.videoMessage?.contextInfo?.participant) {
            senderJid = msg.message.videoMessage.contextInfo.participant
        }
        if (!senderJid && msg.message?.documentMessage?.contextInfo?.participant) {
            senderJid = msg.message.documentMessage.contextInfo.participant
        }
        if (!senderJid) senderJid = msg.key.participantAlt
        if (!senderJid && thisMessageIsFromSelf(msg)) {
            senderJid = selfSenderLid(msg)
        }
        if (!senderJid && isPersonalJid(msg.key.remoteJid)) {
            senderJid = msg.key.remoteJid
        }
        if (!senderJid) {
            // Store-based fallback
            senderJid = (await resolveSenderFromStore(wa, msg)) || msg.key.remoteJid
        }
        // Normalize through LID→PN resolver for authorization check
        const phoneNumber = await normalizeLidNumber(wa, senderJid)

        debug('CommandHandler', 'Authorization check', {
            sessionId,
            sender: senderJid,
            phoneNumber,
        })

        if (!isAuthorized(phoneNumber)) {
            warning('CommandHandler', 'Access denied for number', {
                sessionId,
                sender: senderJid,
                phoneNumber,
            })

            await wa.sendMessage(msg.key.remoteJid, {
                text: 'Anda tidak dapat menggunakan fitur ini.',
            })

            return true
        }

        success('CommandHandler', 'Access granted', {
            sessionId,
            sender: senderJid,
        })

        switch (cmd) {
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

            case '/today-tka': {
                command('CommandHandler', 'Processing /today-tka command (TKA)', {
                    sessionId,
                })

                try {
                    await handleTodayCommand(wa, msg, 'tka')
                    success('CommandHandler', '/today-tka command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleTodayCommand failed (TKA)', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '/rank': {
                command('CommandHandler', 'Processing /rank command', {
                    sessionId,
                })

                try {
                    await handleRankCommand(wa, msg)
                    success('CommandHandler', '/rank command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleRankCommand failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '/rank-tka': {
                command('CommandHandler', 'Processing /rank-tka command (TKA)', {
                    sessionId,
                })

                try {
                    await handleRankCommand(wa, msg, 'tka')
                    success('CommandHandler', '/rank-tka command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleRankCommand failed (TKA)', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '#jurnal': {
                command('CommandHandler', 'Processing #jurnal command (luring, akademik)', {
                    sessionId,
                })

                const parts = text.split(' ')
                let tanggalInput = null
                let customLid = null

                // Extract custom LID from @mention
                const mentionedJid =
                    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
                    msg.message?.imageMessage?.contextInfo?.mentionedJid
                if (mentionedJid && mentionedJid.length > 0) {
                    customLid = extractPhoneNumber(mentionedJid[0])
                    info('CommandHandler', 'Custom LID from @mention', {
                        sessionId,
                        customLid,
                    })
                }

                // Parse arguments after command, skipping @mention parts
                const argParts = parts.slice(1).filter((p) => !p.startsWith('@'))

                if (argParts.length > 0) {
                    tanggalInput = argParts[0]
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

#jurnal 06-02-2026 7h matematika algoritma dasar

Atau untuk guru lain (tag @guru):

#jurnal @628xxx 7h matematika algoritma dasar
#jurnal @628xxx 06-02-2026 7h matematika algoritma dasar`,
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
                    await handleGroupImageMessage(wa, msg, sessionId, tanggalFinal, 'luring', 'akademik', customLid)
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

            case '#jurnal-daring': {
                command('CommandHandler', 'Processing #jurnal-daring command (daring, akademik)', {
                    sessionId,
                })

                const partsDaring = text.split(' ')
                let tanggalInputDaring = null
                let customLidDaring = null

                // Extract custom LID from @mention
                const mentionedJidDaring = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
                if (mentionedJidDaring && mentionedJidDaring.length > 0) {
                    customLidDaring = extractPhoneNumber(mentionedJidDaring[0])
                    info('CommandHandler', 'Custom LID from @mention (daring)', {
                        sessionId,
                        customLid: customLidDaring,
                    })
                }

                // Parse arguments after command, skipping @mention parts
                const argPartsDaring = partsDaring.slice(1).filter((p) => !p.startsWith('@'))

                if (argPartsDaring.length > 0) {
                    tanggalInputDaring = argPartsDaring[0]
                }

                let tanggalFinalDaring = null

                if (tanggalInputDaring) {
                    const regex = /^(\d{2})-(\d{2})-(\d{4})$/

                    if (regex.test(tanggalInputDaring)) {
                        const [dd, mm, yyyy] = tanggalInputDaring.split('-')
                        tanggalFinalDaring = `${yyyy}-${mm}-${dd}`

                        info('CommandHandler', 'Custom date detected for daring', {
                            sessionId,
                            customDate: tanggalFinalDaring,
                        })
                    }
                }

                // Check if there's a quoted message
                const quotedDaring = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage

                debug('CommandHandler', 'Checking for quoted message (daring)', {
                    sessionId,
                    hasQuoted: !!quotedDaring,
                })

                if (!quotedDaring) {
                    warning('CommandHandler', '#jurnal-daring without image reply', {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: `Format salah.

Gunakan:
Reply gambar dengan:

#jurnal-daring 7h matematika algoritma dasar

Atau dengan tanggal:

#jurnal-daring 06-02-2026 7h matematika algoritma dasar

Atau untuk guru lain (tag @guru):

#jurnal-daring @628xxx 7h matematika algoritma dasar
#jurnal-daring @628xxx 06-02-2026 7h matematika algoritma dasar`,
                    })

                    return true
                }

                if (!quotedDaring.imageMessage) {
                    warning('CommandHandler', 'Quoted message is not an image (daring)', {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Pesan yang direply bukan gambar. Mohon reply pesan gambar.',
                    })

                    return true
                }

                debug('CommandHandler', 'Valid #jurnal-daring command, proceeding to handleGroupImageMessage', {
                    sessionId,
                })

                try {
                    await handleGroupImageMessage(
                        wa,
                        msg,
                        sessionId,
                        tanggalFinalDaring,
                        'daring',
                        'akademik',
                        customLidDaring,
                    )
                    success('CommandHandler', '#jurnal-daring command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleGroupImageMessage failed (daring)', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '#ekstra': {
                command('CommandHandler', 'Processing #ekstra command (luring, non_akademik)', {
                    sessionId,
                })

                const partsEkstra = text.split(' ')
                let tanggalInputEkstra = null
                let customLidEkstra = null

                // Extract custom LID from @mention
                const mentionedJidEkstra = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid
                if (mentionedJidEkstra && mentionedJidEkstra.length > 0) {
                    customLidEkstra = extractPhoneNumber(mentionedJidEkstra[0])
                    info('CommandHandler', 'Custom LID from @mention (ekstra)', {
                        sessionId,
                        customLid: customLidEkstra,
                    })
                }

                // Parse arguments after command, skipping @mention parts
                const argPartsEkstra = partsEkstra.slice(1).filter((p) => !p.startsWith('@'))

                if (argPartsEkstra.length > 0) {
                    tanggalInputEkstra = argPartsEkstra[0]
                }

                let tanggalFinalEkstra = null

                if (tanggalInputEkstra) {
                    const regex = /^(\d{2})-(\d{2})-(\d{4})$/

                    if (regex.test(tanggalInputEkstra)) {
                        const [dd, mm, yyyy] = tanggalInputEkstra.split('-')
                        tanggalFinalEkstra = `${yyyy}-${mm}-${dd}`

                        info('CommandHandler', 'Custom date detected for ekstra', {
                            sessionId,
                            customDate: tanggalFinalEkstra,
                        })
                    }
                }

                // Check if there's a quoted message
                const quotedEkstra = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage

                debug('CommandHandler', 'Checking for quoted message (ekstra)', {
                    sessionId,
                    hasQuoted: !!quotedEkstra,
                })

                if (!quotedEkstra) {
                    warning('CommandHandler', '#ekstra without image reply', {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: `Format salah.

Gunakan:
Reply gambar dengan:

#ekstra pramuka pengenalan tali temali

Atau dengan tanggal:

#ekstra 06-02-2026 pramuka pengenalan tali temali

Atau untuk guru lain (tag @guru):

#ekstra @628xxx pramuka pengenalan tali temali
#ekstra @628xxx 06-02-2026 pramuka pengenalan tali temali`,
                    })

                    return true
                }

                if (!quotedEkstra.imageMessage) {
                    warning('CommandHandler', 'Quoted message is not an image (ekstra)', {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Pesan yang direply bukan gambar. Mohon reply pesan gambar.',
                    })

                    return true
                }

                debug('CommandHandler', 'Valid #ekstra command, proceeding to handleGroupImageMessage', {
                    sessionId,
                })

                try {
                    await handleGroupImageMessage(
                        wa,
                        msg,
                        sessionId,
                        tanggalFinalEkstra,
                        'luring',
                        'non_akademik',
                        customLidEkstra,
                    )
                    success('CommandHandler', '#ekstra command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleGroupImageMessage failed (ekstra)', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '#daftar': {
                command('CommandHandler', 'Processing #daftar command', {
                    sessionId,
                })

                try {
                    await handleDaftarCommand(wa, msg, sessionId)
                    success('CommandHandler', '#daftar command processed successfully', {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', 'handleDaftarCommand failed', {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            case '#jurnal-tka':
            case '#jurnal-tka-daring': {
                const isDaringTka = cmd === '#jurnal-tka-daring'
                command('CommandHandler', `Processing ${cmd} command (TKA)`, {
                    sessionId,
                })

                const partsTka = text.split(' ')
                let tanggalInputTka = null
                let customLidTka = null

                // Extract custom LID from @mention
                const mentionedJidTka =
                    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
                    msg.message?.imageMessage?.contextInfo?.mentionedJid
                if (mentionedJidTka && mentionedJidTka.length > 0) {
                    customLidTka = extractPhoneNumber(mentionedJidTka[0])
                    info('CommandHandler', 'Custom LID from @mention (TKA)', {
                        sessionId,
                        customLid: customLidTka,
                    })
                }

                // Parse arguments after command, skipping @mention parts
                const argPartsTka = partsTka.slice(1).filter((p) => !p.startsWith('@'))

                if (argPartsTka.length > 0) {
                    tanggalInputTka = argPartsTka[0]
                }

                let tanggalFinalTka = null

                if (tanggalInputTka) {
                    const parsedDate = parseDate(tanggalInputTka)
                    if (parsedDate) {
                        tanggalFinalTka = parsedDate
                        info('CommandHandler', 'Custom date detected for TKA', {
                            sessionId,
                            customDate: tanggalFinalTka,
                        })
                    }
                }

                // Check if there's a quoted message
                const quotedTka = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage

                if (!quotedTka) {
                    warning('CommandHandler', `${cmd} without image reply`, {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: `Format salah.

Gunakan:
Reply gambar dengan:

${cmd} 8A matematika dasar

Atau dengan tanggal:

${cmd} 06-02-2026 8A matematika dasar

Atau untuk guru lain (tag @guru):

${cmd} @628xxx 8A matematika dasar
${cmd} @628xxx 06-02-2026 8A matematika dasar`,
                    })

                    return true
                }

                if (!quotedTka.imageMessage) {
                    warning('CommandHandler', `Quoted message is not an image (${cmd})`, {
                        sessionId,
                    })

                    await wa.sendMessage(msg.key.remoteJid, {
                        text: 'Pesan yang direply bukan gambar. Mohon reply pesan gambar.',
                    })

                    return true
                }

                try {
                    await handleGroupImageMessage(
                        wa,
                        msg,
                        sessionId,
                        tanggalFinalTka,
                        isDaringTka ? 'daring' : 'luring',
                        'akademik',
                        customLidTka,
                        'tka',
                    )
                    success('CommandHandler', `${cmd} command processed successfully`, {
                        sessionId,
                    })
                } catch (err) {
                    error('CommandHandler', `handleGroupImageMessage failed (${cmd})`, {
                        sessionId,
                        error: err.message,
                    })
                }

                return true
            }

            default:
                debug('CommandHandler', 'Unknown command after switch', {
                    sessionId,
                    command: cmd,
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
 * @param {string} metode - Metode pembelajaran: 'luring' (default) atau 'daring'
 * @param {string} jenis - Jenis jurnal: 'akademik' (default) atau 'non_akademik'
 * @param {string|null} customLid - Custom LID (no_lid guru) from @mention, overrides default LID detection
 * @param {string} kategori - Kategori jurnal: 'bimbel' (default) atau 'tka'
 */
const handleGroupImageMessage = async (
    wa,
    msg,
    sessionId,
    tanggalCustom = null,
    metode = 'luring',
    jenis = 'akademik',
    customLid = null,
    kategori = 'bimbel',
) => {
    try {
        console.log('==============================================')
        console.log('[JURNAL] Memulai proses input jurnal')
        console.log('==============================================')

        let lid = ''
        let kelas = ''
        let materi = ''
        let tanggalKirim = tanggalCustom

        // Get LID with better error handling
        // Priority: customLid (from @mention) > quoted participant > sender participant
        // IMPORTANT: In groups, msg.key.remoteJid is the GROUP ID, NOT the sender's phone number
        // We must use msg.key.participant (the sender's actual JID in the group) or quoted participant
        // Baileys may deliver the first upsert of a new message with key.participant undefined
        // (participant resolution is async / LID mapping not yet cached), so we add fallbacks:
        // contextInfo.participant (media messages) and store-based lookup.
        try {
            if (customLid) {
                lid = await normalizeLidNumber(wa, customLid)
                console.log('[INFO] Mode CUSTOM LID - LID dari @mention:', lid)
            } else if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
                const quotedParticipant = msg.message.extendedTextMessage.contextInfo.participant
                lid = await normalizeLidNumber(wa, quotedParticipant)
                console.log('[INFO] Mode QUOTE - LID dari quoted participant:', lid)
            } else if (msg.message?.imageMessage?.contextInfo?.participant) {
                // Direct image message: sender is in imageMessage.contextInfo.participant
                lid = await normalizeLidNumber(wa, msg.message.imageMessage.contextInfo.participant)
                console.log('[INFO] Mode IMAGE_CONTEXT - LID dari imageMessage.contextInfo.participant:', lid)
            } else if (msg.message?.videoMessage?.contextInfo?.participant) {
                lid = await normalizeLidNumber(wa, msg.message.videoMessage.contextInfo.participant)
                console.log('[INFO] Mode VIDEO_CONTEXT - LID dari videoMessage.contextInfo.participant:', lid)
            } else if (msg.message?.documentMessage?.contextInfo?.participant) {
                lid = await normalizeLidNumber(wa, msg.message.documentMessage.contextInfo.participant)
                console.log('[INFO] Mode DOCUMENT_CONTEXT - LID dari documentMessage.contextInfo.participant:', lid)
            } else if (msg.key.participant) {
                // msg.key.participant is the actual sender's JID in a group
                // This is the correct field to use for sender identification in groups
                lid = await normalizeLidNumber(wa, msg.key.participant)
                console.log('[INFO] Mode PARTICIPANT - LID dari msg.key.participant:', lid)
            } else if (msg.key.participantAlt) {
                // participantAlt may contain the linked device ID (often a LID)
                lid = await normalizeLidNumber(wa, msg.key.participantAlt)
                console.log('[INFO] Mode PARTICIPANT_ALT - LID dari msg.key.participantAlt:', lid)
            } else if (thisMessageIsFromSelf(msg)) {
                // Messages sent by the bot's own account carry the bot's JID in remoteJid/participant
                lid = selfSenderLid(msg)
                console.log('[INFO] Mode SELF - LID dari pesan bot sendiri:', lid)
            } else if (isPersonalJid(msg.key.remoteJid)) {
                // Only use remoteJid if it's a personal chat (not a group)
                lid = await normalizeLidNumber(wa, msg.key.remoteJid)
                console.log('[INFO] Mode PERSONAL CHAT - LID dari remoteJid:', lid)
            } else {
                // Store-based fallback: the message may already be in the session store with
                // a fully populated key.participant, even though the live msg object lacks it.
                const storedSender = await resolveSenderFromStore(wa, msg)
                if (storedSender) {
                    lid = storedSender
                    console.log('[INFO] Mode STORE - LID dari session store:', lid)
                } else {
                    // If we're in a group and no participant info is available,
                    // this is a Baileys data issue - we cannot reliably determine the sender
                    console.error('[ERROR] Cannot determine sender in group - no participant info available')
                    throw new Error('Tidak dapat mengidentifikasi pengirim dalam grup')
                }
            }

            if (!lid) {
                throw new Error('Tidak dapat mengidentifikasi pengirim')
            }

            // Validate that lid looks like a phone number (digits only, reasonable length)
            const lidClean = lid.replace(/\D/g, '')
            if (lidClean.length < 8 || lidClean.length > 15) {
                console.warn(
                    '[WARN] LID does not look like a valid phone number:',
                    lid,
                    '(length:',
                    lidClean.length,
                    ')',
                )
                // Don't throw here - some systems use different ID formats
                // But log a warning for debugging
            }
        } catch (error) {
            console.error('[ERROR] Gagal mendapatkan LID:', error)

            // If sender couldn't be resolved (likely a fresh upsert with missing participant),
            // return a sentinel so whatsapp.js can retry processing after a short delay
            // instead of failing immediately. This fixes "first send fails, second works".
            if (
                error.message === 'Tidak dapat mengidentifikasi pengirim dalam grup' ||
                error.message === 'Tidak dapat mengidentifikasi pengirim'
            ) {
                return SENDER_UNRESOLVED
            }

            await wa.sendMessage(
                msg.key.remoteJid,
                { text: '❌ Gagal mengidentifikasi pengirim. Silakan coba lagi atau tag @nomor Anda.' },
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

                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: wa.updateMediaMessage })

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

        // If no text/caption, silently ignore the image-only message
        if (!text) {
            console.log('[INFO] Gambar tanpa caption, diabaikan')
            return
        }

        // Filter out @mention parts from text parsing (they are LID references, not content)
        const parts = text.split(' ').filter((part) => part.trim() !== '' && !part.startsWith('@'))

        // Detect exact lowercase token 'tka' — this drives the TKA (auto-detected) mode
        const lowerParts = parts.map((part) => part.toLowerCase())
        const tkaIdx = lowerParts.indexOf('tka')

        // Mode COMMAND #JURNAL-TKA / #JURNAL-TKA-DARING
        if (parts[0].toLowerCase() === '#jurnal-tka' || parts[0].toLowerCase() === '#jurnal-tka-daring') {
            console.log('[INFO] Mode COMMAND', parts[0], 'terdeteksi')

            if (parts.length >= 2) {
                const parsedDate = parseDate(parts[1])
                if (parsedDate) {
                    tanggalKirim = parsedDate
                    kelas = parts[2] || ''
                    materi = parts.slice(3).join(' ')
                    console.log('[INFO] Tanggal custom (TKA):', tanggalKirim)
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
#jurnal-tka 8A matematika dasar

Atau dengan tanggal:
#jurnal-tka 06-02-2026 8A matematika dasar

Atau untuk guru lain (tag @guru):
#jurnal-tka @628xxx 8A matematika dasar
#jurnal-tka @628xxx 06-02-2026 8A matematika dasar

Varian daring:
#jurnal-tka-daring 8A matematika dasar`,
                    },
                    { quoted: msg },
                )
                return
            }
        }
        // Mode COMMAND #JURNAL
        else if (parts[0].toLowerCase() === '#jurnal') {
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
#jurnal 06-02-2026 7h matematika algoritma dasar

Atau untuk guru lain (tag @guru):
#jurnal @628xxx 7h matematika algoritma dasar
#jurnal @628xxx 06-02-2026 7h matematika algoritma dasar`,
                    },
                    { quoted: msg },
                )
                return
            }
        }
        // Mode COMMAND #JURNAL-DARING
        else if (parts[0].toLowerCase() === '#jurnal-daring') {
            console.log('[INFO] Mode COMMAND #jurnal-daring terdeteksi')

            if (parts.length >= 2) {
                const parsedDate = parseDate(parts[1])
                if (parsedDate) {
                    tanggalKirim = parsedDate
                    kelas = parts[2] || ''
                    materi = parts.slice(3).join(' ')
                    console.log('[INFO] Tanggal custom (daring):', tanggalKirim)
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
#jurnal-daring 7h matematika algoritma dasar

Atau dengan tanggal:
#jurnal-daring 06-02-2026 7h matematika algoritma dasar

Atau untuk guru lain (tag @guru):
#jurnal-daring @628xxx 7h matematika algoritma dasar
#jurnal-daring @628xxx 06-02-2026 7h matematika algoritma dasar`,
                    },
                    { quoted: msg },
                )
                return
            }
        }
        // Mode COMMAND #EKSTRA (tanpa kelas, hanya materi)
        else if (parts[0].toLowerCase() === '#ekstra') {
            console.log('[INFO] Mode COMMAND #ekstra terdeteksi')

            if (parts.length >= 2) {
                const parsedDate = parseDate(parts[1])
                if (parsedDate) {
                    tanggalKirim = parsedDate
                    kelas = '' // kelas kosong untuk ekstra
                    materi = parts.slice(2).join(' ')
                    console.log('[INFO] Tanggal custom (ekstra):', tanggalKirim)
                } else {
                    kelas = '' // kelas kosong untuk ekstra
                    materi = parts.slice(1).join(' ')
                }
            } else {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    {
                        text: `❌ Format salah.

Gunakan:
#ekstra pramuka pengenalan tali temali

Atau dengan tanggal:
#ekstra 06-02-2026 pramuka pengenalan tali temali

Atau untuk guru lain (tag @guru):
#ekstra @628xxx pramuka pengenalan tali temali
#ekstra @628xxx 06-02-2026 pramuka pengenalan tali temali`,
                    },
                    { quoted: msg },
                )
                return
            }
        }
        // Mode CAPTION DARING (daring [kelas] [materi])
        else if (tkaIdx !== -1) {
            // **FITUR 2: Deteksi token 'tka' di caption langsung (termasuk "daring 8A tka ...")**
            console.log('[INFO] Mode CAPTION TKA terdeteksi')

            // Validasi: 'tka' tidak boleh di awal (tkaIdx === 0 → format salah)
            if (tkaIdx === 0) {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    {
                        text: `❌ Format jurnal salah.
Tuliskan kelas terlebih dahulu, contoh: "8A tka matematika dasar"`,
                    },
                    { quoted: msg },
                )
                return
            }

            // Handle prefix 'daring': jika parts[0] === 'daring' dan tkaIdx > 0
            if (parts[0].toLowerCase() === 'daring' && tkaIdx > 0) {
                metode = 'daring'
                kelas = parts[tkaIdx - 1]
                materi = parts.slice(tkaIdx + 1).join(' ')
            } else {
                // Format standar: "kelas tka materi"
                kelas = parts[tkaIdx - 1]
                materi = parts.slice(tkaIdx + 1).join(' ')
            }

            // Set kategori ke TKA
            kategori = 'tka'
        }
        // Mode CAPTION DARING (daring [kelas] [materi])
        else if (parts[0].toLowerCase() === 'daring') {
            console.log('[INFO] Mode CAPTION daring terdeteksi')
            metode = 'daring'
            kelas = parts[1] || ''
            materi = parts.slice(2).join(' ')
        }
        // Mode CAPTION LANGSUNG (bimbel biasa)
        else {
            kelas = parts[0] || ''
            materi = parts.slice(1).join(' ')
        }

        kelas = sanitizeText(mapAliasKelas(kelas))
        materi = sanitizeText(materi)

        // Validate parsing result (kelas optional untuk non_akademik/ekstra)
        if ((!kelas && jenis !== 'non_akademik') || !materi) {
            console.log('[ERROR] Format parsing gagal:', { kelas, materi, jenis })

            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: `❌ Format jurnal salah.

Contoh yang benar:

📌 Kirim gambar langsung (luring/akademik):
7h matematika algoritma dasar atau olim-mtk matematika dasar

📌 Caption daring:
daring 7h matematika algoritma dasar

📌 Atau dengan reply:
#jurnal 7h matematika algoritma dasar
#jurnal-daring 7h matematika algoritma dasar
#ekstra pramuka pengenalan tali temali

📌 Tanggal custom:
#jurnal 06-02-2026 7h matematika algoritma dasar
#jurnal-daring 06-02-2026 7h matematika algoritma dasar
#ekstra 06-02-2026 pramuka pengenalan tali temali

📌 Untuk guru lain (tag @guru):
#jurnal @628xxx 7h matematika algoritma dasar
#jurnal-daring @628xxx 7h matematika algoritma dasar
#ekstra @628xxx pramuka pengenalan tali temali`,
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
        console.log('- Metode :', metode)
        console.log('- Jenis  :', jenis)
        console.log('- Kategori:', kategori)

        // === JOURNAL QUEUE SYSTEM ===
        // Step 1: Check deduplication - if this message was already sent, skip
        const messageId = msg.key.id
        const existingEntry = journalQueue.checkMessage(messageId, sessionId, msg.key.remoteJid)

        if (existingEntry && existingEntry.status === JournalStatus.SENT) {
            console.log('[INFO] Jurnal sudah dikirim sebelumnya, skip:', messageId)
            info('CommandHandler', 'Journal already sent, skipping', {
                messageId,
                entryId: existingEntry.id,
            })
            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: '✅ Jurnal ini sudah berhasil dikirim sebelumnya.',
                },
                { quoted: msg },
            )
            return
        }

        if (existingEntry && existingEntry.status === JournalStatus.PROCESSING) {
            console.log('[INFO] Jurnal sedang diproses, skip:', messageId)
            await wa.sendMessage(
                msg.key.remoteJid,
                {
                    text: '⏳ Jurnal ini sedang dalam proses pengiriman.',
                },
                { quoted: msg },
            )
            return
        }

        // Step 2: Build data and save to database FIRST (persistent queue)
        const fotoData = `data:${mediaMessage.mimetype};base64,${mediaMessage.base64}`
        const data = {
            no_lid: lid,
            kelas: kelas,
            materi: materi,
            keterangan: 'Jurnal via WhatsApp Bot',
            foto: fotoData,
            tanggal: tanggalKirim,
            metode: metode,
            jenis: jenis,
            kategori: kategori,
        }

        const queueEntry = journalQueue.enqueue({
            messageId: messageId,
            sessionId: sessionId,
            groupJid: msg.key.remoteJid,
            no_lid: lid,
            kelas: kelas,
            materi: materi,
            tanggal: tanggalKirim,
            metode: metode,
            jenis: jenis,
            kategori: kategori,
            foto: fotoData,
            keterangan: 'Jurnal via WhatsApp Bot',
        })

        console.log('[INFO] Jurnal disimpan ke antrian database:', {
            queueId: queueEntry.id,
            isNew: queueEntry.isNew,
            status: queueEntry.status,
        })

        // React processing
        await wa.sendMessage(msg.key.remoteJid, {
            react: {
                text: '⏳',
                key: msg.key,
            },
        })

        // Route to the correct SIM endpoint: TKA journals use /create_jurnal_tka
        const jurnalEndpoint = kategori === 'tka' ? '/create_jurnal_tka' : '/create_jurnal'

        // Step 3: If entry is pending (new or retry), try to send to API immediately
        // If it fails, the entry stays as 'pending' in DB and will be retried later
        if (queueEntry.status === JournalStatus.PENDING || queueEntry.status === JournalStatus.FAILED) {
            console.log('[INFO] Mengirim data ke API dengan retry logic...')
            try {
                const response = await retryApiCall(
                    () =>
                        axios.post(`${API_CONFIG.base_url}${jurnalEndpoint}`, data, {
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
                    // Mark as sent in database
                    journalQueue.updateStatus(queueEntry.id, JournalStatus.SENT)

                    const jurnalData = response.data.data.jurnal_data

                    const successMessage =
                        `✅ Jurnal berhasil disimpan\n\n` +
                        `👨‍🏫 Guru   : ${jurnalData.nama_guru}\n` +
                        (kelas ? `🏫 Kelas  : ${kelas}\n` : '') +
                        `📚 Materi : ${materi}\n` +
                        `📅 Tgl    : ${jurnalData.tanggal}\n` +
                        `💻 Metode : ${metode === 'daring' ? 'Daring' : 'Luring'}\n` +
                        `📋 Jenis  : ${jenis === 'non_akademik' ? 'Non-Akademik' : 'Akademik'}`

                    await wa.sendMessage(msg.key.remoteJid, { text: successMessage }, { quoted: msg })
                    // React sukses
                    await wa.sendMessage(msg.key.remoteJid, {
                        react: {
                            text: '✅',
                            key: msg.key,
                        },
                    })
                    console.log('[SUCCESS] Jurnal berhasil disimpan')
                } else {
                    // API returned but not success - keep as pending for retry
                    const errorMsg = response.data?.message || 'API returned non-success status'
                    journalQueue.updateStatus(queueEntry.id, JournalStatus.PENDING, {
                        lastError: errorMsg,
                        attempts: 1,
                    })

                    // React gagal
                    await wa.sendMessage(msg.key.remoteJid, {
                        react: {
                            text: '❌',
                            key: msg.key,
                        },
                    })
                    console.log('[ERROR] Response API gagal:', response.data)

                    await wa.sendMessage(
                        msg.key.remoteJid,
                        {
                            text: '❌ Gagal menyimpan jurnal. Data disimpan ke antrian dan akan dikirim ulang secara otomatis.',
                        },
                        { quoted: msg },
                    )
                }
            } catch (apiError) {
                // API call failed - keep as pending for retry later
                const errorMsg = apiError.response?.data?.message || apiError.message || 'Unknown error'
                journalQueue.updateStatus(queueEntry.id, JournalStatus.PENDING, {
                    lastError: errorMsg,
                    attempts: 1,
                })

                console.error('[ERROR] API call failed after retries:', apiError)

                let errorMessage =
                    '❌ Terjadi kesalahan saat mengirim ke API.\n📝 Data jurnal disimpan ke antrian dan akan dikirim ulang secara otomatis ketika server tersedia.'

                if (apiError.response) {
                    console.error('[ERROR] API Response:', {
                        status: apiError.response.status,
                        data: apiError.response.data,
                    })
                } else if (apiError.request) {
                    console.error('[ERROR] No response from API:', apiError.request)
                } else {
                    console.error('[ERROR] API Error:', apiError.message)
                }

                await wa.sendMessage(msg.key.remoteJid, { text: errorMessage }, { quoted: msg })
            }
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
            `   Format: #laporan guru @tag [bulan]\n` +
            `   Contoh: #laporan guru @628xxxx februari\n\n` +
            `💰 */billing* - Mengambil laporan billing bulanan\n` +
            `   Format: /billing [bulan] [tahun]\n` +
            `   Contoh: /billing februari 2026\n` +
            `   Contoh: /billing 2 2026\n` +
            `   Contoh: /billing februari\n\n` +
            `📅 */today* - Melihat siapa yang sudah mengisi jurnal\n` +
            `   Format: /today\n` +
            `   Format: /today [tanggal]\n` +
            `   Contoh: /today 07-10-2026\n` +
            `   Menampilkan daftar guru yang sudah submit jurnal\n\n` +
            `🏅 */rank* - Melihat ranking guru berdasarkan jumlah jurnal\n` +
            `   Format: /rank [bulan] [tahun]\n` +
            `   Contoh: /rank\n` +
            `   Contoh: /rank februari\n` +
            `   Contoh: /rank februari 2026\n` +
            `   Contoh: /rank 2 2026\n\n` +
            `📝 *#jurnal* - Input jurnal luring/akademik dengan gambar\n` +
            `   Format: #jurnal [tanggal] kelas materi\n` +
            `   Contoh: #jurnal 7h matematika algoritma dasar\n` +
            `   Contoh: #jurnal 06-02-2026 7h matematika algoritma dasar\n` +
            `   Untuk guru lain: #jurnal @628xxx 7h matematika algoritma dasar\n\n` +
            `💻 *#jurnal-daring* - Input jurnal daring/akademik dengan gambar\n` +
            `   Format: #jurnal-daring [tanggal] kelas materi\n` +
            `   Contoh: #jurnal-daring 7h matematika algoritma dasar\n` +
            `   Contoh: #jurnal-daring 06-02-2026 7h matematika algoritma dasar\n` +
            `   Untuk guru lain: #jurnal-daring @628xxx 7h matematika algoritma dasar\n\n` +
            `🏅 *#ekstra* - Input jurnal luring/non-akademik (ekstrakurikuler) dengan gambar\n` +
            `   Format: #ekstra [tanggal] materi\n` +
            `   Contoh: #ekstra pramuka pengenalan tali temali\n` +
            `   Contoh: #ekstra 06-02-2026 pramuka pengenalan tali temali\n` +
            `   Untuk guru lain: #ekstra @628xxx pramuka pengenalan tali temali\n\n` +
            `📌 *Caption langsung pada gambar:*\n` +
            `   Luring/Akademik: 7h matematika algoritma dasar\n` +
            `   Daring/Akademik: daring 7h matematika algoritma dasar\n` +
            `   TKA (kategori terpisah): 8A tka matematika dasar\n` +
            `   TKA daring: daring 8A tka matematika dasar\n\n` +
            `🎯 *#jurnal-tka / #jurnal-tka-daring* - Input jurnal TKA (kategori TKA, terpisah dari Bimbel)\n` +
            `   Format: #jurnal-tka [tanggal] kelas materi (reply foto)\n` +
            `   Contoh: #jurnal-tka 8A matematika dasar\n` +
            `   Contoh: #jurnal-tka 06-02-2026 8A matematika dasar\n` +
            `   Untuk guru lain: #jurnal-tka @628xxx 8A matematika dasar\n` +
            `   Varian daring: #jurnal-tka-daring 8A matematika dasar\n\n` +
            `📝 *#daftar* - Daftarkan nomor WA guru (hanya admin)\n` +
            `   Format: #daftar Nama @mention\n` +
            `   Contoh: #daftar Budi Santoso @628123456789\n` +
            `   Balas ya / tidak untuk konfirmasi\n\n` +
            ` *Catatan:*\n` +
            `   - Gunakan format tanggal DD-MM-YYYY untuk tanggal custom\n` +
            `   - Reply gambar untuk input jurnal\n` +
            `   - Tag @guru untuk input jurnal atas nama guru lain\n` +
            `   - Nama bulan: januari, februari, maret, dst.\n` +
            `   - Untuk billing, tahun default adalah tahun berjalan\n\n` +
            `⚠️ *Akses Terbatas*\n` +
            `   Fitur ini hanya dapat diakses oleh nomor terdaftar.`

        await wa.sendMessage(
            msg.key.remoteJid,
            {
                text: menuMessage,
            },
            { quoted: msg },
        )

        const voice = await generateVoiceNote(`Berikut menu yang ada didalam bot`)

        await wa.sendMessage(
            msg.key.remoteJid,
            {
                audio: fs.readFileSync(voice.oggPath),
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true,
            },
            { quoted: msg },
        )
        fs.unlinkSync(voice.mp3Path)
        fs.unlinkSync(voice.oggPath)
        // React sukses
        await wa.sendMessage(msg.key.remoteJid, {
            react: {
                text: '✅',
                key: msg.key,
            },
        })
        console.log('[SUCCESS] Menu berhasil ditampilkan')
    } catch (error) {
        // React gagal
        await wa.sendMessage(msg.key.remoteJid, {
            react: {
                text: '❌',
                key: msg.key,
            },
        })
        console.error('[ERROR] Gagal menampilkan menu:', error)
        await wa.sendMessage(
            msg.key.remoteJid,
            {
                text: '❌ Terjadi kesalahan saat menampilkan menu.',
            },
            { quoted: msg },
        )
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

            const requestedMonth = commandParts.slice(2).find((part) => MONTH_MAP[part])

            if (requestedMonth) {
                monthNum = MONTH_MAP[requestedMonth]
                monthLabel = requestedMonth
            }
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
                no_lid = extractPhoneNumber(msg.message.extendedTextMessage.contextInfo.mentionedJid[0])
            } else if (commandParts[2]) {
                no_lid = commandParts[2].replace(/[@a-z.]/gi, '')
            }

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
            // React sukses
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '✅',
                    key: msg.key,
                },
            })

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
            // React gagal
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '❌',
                    key: msg.key,
                },
            })
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
                            text: '❌ Format salah.\n\nGunakan:\n/billing [bulan] [tahun]\n\nContoh:\n/billing februari 2026\n/billing 2 2026\n/billing februari\n\nNama bulan: januari, februari, maret, dst.',
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
                        text: '❌ Tahun tidak valid.\n\nGunakan tahun antara 2000-2100.\n\nContoh:\n/billing februari 2026',
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
            // React sukses
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '✅',
                    key: msg.key,
                },
            })
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
            // React gagal
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '❌',
                    key: msg.key,
                },
            })
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
 * Handle rank command - retrieves ranking of teachers based on journal upload count
 *
 * @param {import('baileys').AnyWASocket} wa - The WhatsApp session
 * @param {object} msg - The message object
 * @param {'bimbel'|'tka'} kategori - Kategori jurnal (bimbel default, tka untuk /rank-tka)
 */
const handleRankCommand = async (wa, msg, kategori = 'bimbel') => {
    try {
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (kategori === 'tka') {
            if (!messageContent.toLowerCase().startsWith('/rank-tka')) {
                return
            }
        } else if (!messageContent.toLowerCase().startsWith('/rank')) {
            // '/rank' must be exact, not '/rank-tka'
            const firstWord = messageContent.toLowerCase().split(' ')[0]
            if (firstWord !== '/rank') return
        }

        const commandParts = messageContent.toLowerCase().split(' ')

        const currentYear = new Date().getFullYear()
        const currentMonth = new Date().getMonth() + 1

        // Default values
        let monthNum = currentMonth
        let yearNum = currentYear
        let monthLabel = Object.keys(MONTH_MAP).find((k) => MONTH_MAP[k] === currentMonth)

        // Parse command
        // Format: /rank [bulan] [tahun]
        // Example: /rank februari 2026
        // Example: /rank 2 2026
        // Example: /rank februari
        // Example: /rank (default: bulan ini)

        if (commandParts.length >= 2) {
            if (MONTH_MAP[commandParts[1]]) {
                monthNum = MONTH_MAP[commandParts[1]]
                monthLabel = commandParts[1]
            } else {
                const parsedMonth = parseInt(commandParts[1])
                if (!isNaN(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12) {
                    monthNum = parsedMonth
                    monthLabel = Object.keys(MONTH_MAP).find((k) => MONTH_MAP[k] === parsedMonth)
                } else {
                    await wa.sendMessage(
                        msg.key.remoteJid,
                        {
                            text: '❌ Format salah.\n\nGunakan:\n/rank [bulan] [tahun]\n\nContoh:\n/rank februari 2026\n/rank 2 2026\n/rank februari\n/rank\n\nNama bulan: januari, februari, maret, dst.',
                        },
                        { quoted: msg },
                    )
                    return
                }
            }
        }

        if (commandParts.length >= 3) {
            const parsedYear = parseInt(commandParts[2])
            if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) {
                yearNum = parsedYear
            } else {
                await wa.sendMessage(
                    msg.key.remoteJid,
                    {
                        text: '❌ Tahun tidak valid.\n\nGunakan tahun antara 2000-2100.\n\nContoh:\n/rank februari 2026',
                    },
                    { quoted: msg },
                )
                return
            }
        }

        // Build URL
        const url = `${API_CONFIG.base_url}/${kategori === 'tka' ? '/get_rank_jurnal_tka' : '/get_rank_jurnal'}?bulan=${monthNum}&tahun=${yearNum}`

        console.log('==============================================')
        console.log('[RANK] Memulai proses pengambilan ranking jurnal')
        console.log('[INFO] URL      :', url)
        console.log('[INFO] Bulan    :', monthNum, `(${monthLabel})`)
        console.log('[INFO] Tahun    :', yearNum)
        console.log('==============================================')

        console.log('[STEP 1] Mengambil data ranking dari API dengan retry logic...')

        // React processing
        await wa.sendMessage(msg.key.remoteJid, {
            react: {
                text: '⏳',
                key: msg.key,
            },
        })

        const response = await retryApiCall(
            () =>
                axios.get(url, {
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
            console.log('[STEP 3] Memformat data ranking...')

            const rankData = response.data.data || []
            const totalGuru = rankData.length

            console.log('[INFO] Total guru:', totalGuru)

            if (totalGuru === 0) {
                const noDataMessage =
                    `🏅 *RANKING JURNAL GURU*\n\n` +
                    `📅 Bulan: ${monthLabel} ${yearNum}\n\n` +
                    `❌ *Belum ada data jurnal untuk bulan ini.*\n\n` +
                    `💡 Gunakan #jurnal untuk menginput jurnal.`

                await wa.sendMessage(msg.key.remoteJid, { text: noDataMessage }, { quoted: msg })
                await wa.sendMessage(msg.key.remoteJid, {
                    react: {
                        text: '✅',
                        key: msg.key,
                    },
                })
                console.log('[SUCCESS] Pesan "belum ada data" berhasil dikirim')
            } else {
                // Calculate statistics
                const totalJurnal = rankData.reduce((sum, guru) => sum + (guru.total_jurnal || 0), 0)
                const avgJurnal = totalJurnal / totalGuru

                // Format the ranking list
                let rankMessage = `🏅 *RANKING JURNAL GURU*\n\n`
                rankMessage += `📅 Bulan: ${monthLabel} ${yearNum}\n`
                rankMessage += `📊 Total: ${totalJurnal} jurnal dari ${totalGuru} guru\n`
                rankMessage += `📈 Rata-rata: ${avgJurnal.toFixed(1)} jurnal/guru\n\n`
                rankMessage += `🏆 *Top Ranking:*\n\n`

                rankData.forEach((guru, index) => {
                    const rank = index + 1
                    let medal = ''

                    if (rank === 1) medal = '🥇'
                    else if (rank === 2) medal = '🥈'
                    else if (rank === 3) medal = '🥉'
                    else medal = `${rank}.`

                    rankMessage += `${medal} ${guru.nama_guru}\n`
                    rankMessage += `   📝 Jurnal: ${guru.total_jurnal}x`

                    if (guru.total_luring) {
                        rankMessage += ` (Luring: ${guru.total_luring}`
                    }
                    if (guru.total_daring) {
                        rankMessage += ` | Daring: ${guru.total_daring}`
                    }
                    if (guru.total_non_akademik) {
                        rankMessage += ` | Ekstra: ${guru.total_non_akademik}`
                    }
                    if (guru.total_luring || guru.total_daring || guru.total_non_akademik) {
                        rankMessage += `)`
                    }

                    rankMessage += '\n'
                })

                rankMessage += `\n📌 *Catatan:*\n`
                rankMessage += `   - Data diambil secara real-time dari sistem\n`
                rankMessage += `   - Ranking berdasarkan jumlah jurnal terbanyak\n`
                rankMessage += `   - Luring = tatap muka, Daring = online, Ekstra = non-akademik\n\n`
                rankMessage += `💡 Gunakan #jurnal untuk menginput jurnal.`

                await wa.sendMessage(msg.key.remoteJid, { text: rankMessage }, { quoted: msg })

                await wa.sendMessage(msg.key.remoteJid, {
                    react: {
                        text: '✅',
                        key: msg.key,
                    },
                })

                console.log('[SUCCESS] Ranking jurnal berhasil dikirim')
            }
        } else {
            console.log('==============================================')
            console.log('[ERROR] API mengembalikan status bukan 200')
            console.log('[ERROR] Status :', response.status)
            console.log('==============================================')

            await wa.sendMessage(
                msg.key.remoteJid,
                { text: '❌ Maaf, terjadi kesalahan saat mengambil data ranking jurnal.' },
                { quoted: msg },
            )
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '❌',
                    key: msg.key,
                },
            })
        }
    } catch (error) {
        console.log('==============================================')
        console.log('[ERROR] Gagal saat memproses perintah /rank')
        console.log('==============================================')

        if (error.response) {
            console.log('[ERROR] Status  :', error.response.status)
            console.log('[ERROR] Data    :', error.response.data)
        } else if (error.request) {
            console.log('[ERROR] Tidak ada response dari API')
        } else {
            console.log('[ERROR] Message :', error.message)
        }

        console.log('[ERROR] Stack Trace:')
        console.log(error.stack)

        console.log('==============================================')

        try {
            await wa.sendMessage(
                msg.key.remoteJid,
                { text: '❌ Maaf, terjadi kesalahan saat memproses permintaan ranking jurnal.' },
                { quoted: msg },
            )
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '❌',
                    key: msg.key,
                },
            })
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
 * @param {'bimbel'|'tka'} kategori - Kategori jurnal (bimbel default, tka untuk /today-tka)
 */
const handleTodayCommand = async (wa, msg, kategori = 'bimbel') => {
    try {
        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

        if (kategori === 'tka') {
            if (!messageContent.toLowerCase().startsWith('/today-tka')) {
                return
            }
        } else if (!messageContent.toLowerCase().startsWith('/today')) {
            const firstWord = messageContent.toLowerCase().split(' ')[0]
            if (firstWord !== '/today') return
        }

        // Parse optional date argument (DD-MM-YYYY format)
        const commandParts = messageContent.toLowerCase().split(' ')
        let customDate = null

        if (commandParts.length >= 2) {
            const parsedDate = parseDate(commandParts[1])
            if (parsedDate) {
                customDate = parsedDate
                console.log('[INFO] Custom date detected:', customDate)
            } else {
                console.log('[WARN] Invalid date format:', commandParts[1])
                await wa.sendMessage(
                    msg.key.remoteJid,
                    { text: '❌ Format tanggal salah. Gunakan format DD-MM-YYYY, contoh: /today 07-10-2026' },
                    { quoted: msg },
                )
                return
            }
        }

        // Get today's date in YYYY-MM-DD format (or use custom date)
        const today = customDate || new Date().toISOString().split('T')[0]

        console.log('==============================================')
        console.log('[TODAY] Memulai proses pengambilan jurnal')
        console.log('[INFO] Tanggal:', today)
        console.log('==============================================')

        console.log('[STEP 1] Mengambil data jurnal dari API dengan retry logic...')

        const url = `${API_CONFIG.base_url}${kategori === 'tka' ? '/get_jurnal_today_tka' : '/get_jurnal_today'}`

        const response = await retryApiCall(
            () =>
                axios.get(url, {
                    params: {
                        tanggal: today,
                    },
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
                // React sukses
                await wa.sendMessage(msg.key.remoteJid, {
                    react: {
                        text: '✅',
                        key: msg.key,
                    },
                })
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

                // React sukses
                await wa.sendMessage(msg.key.remoteJid, {
                    react: {
                        text: '✅',
                        key: msg.key,
                    },
                })

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
            // React gagal
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '❌',
                    key: msg.key,
                },
            })
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
            // React gagal
            await wa.sendMessage(msg.key.remoteJid, {
                react: {
                    text: '❌',
                    key: msg.key,
                },
            })
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
    handleRankCommand,
    handleDaftarCommand,
    checkDaftarConfirmation,
    mapAliasKelas,
    isAuthorized,
    extractPhoneNumber,
    normalizeLidNumber,
    SENDER_UNRESOLVED,
}
