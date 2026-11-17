/**
 * Parser command hashtag jurnal pada caption foto.
 *
 * Format:
 *   #tka kelas materi            -> kategori tka, luring
 *   #tka daring kelas materi     -> kategori tka, daring
 *   #bimbel kelas materi         -> kategori bimbel (default), luring
 *   #bimbel daring kelas materi  -> kategori bimbel, daring
 *   #to kelas materi             -> kategori tryout, luring
 *   #to daring kelas materi      -> kategori tryout, daring
 *   #tahfidz kelas materi        -> kategori bimbel (sama seperti caption lama
 *                                   "8i tahfidz": kelas + materi, mode default)
 *
 * Fungsi murni (tanpa dependensi) agar mudah diuji unit test.
 */

// Pemetaan command hashtag -> kategori jurnal di SIM.
// #tahfidz sengaja memakai kategori 'bimbel' karena perilakunya identik
// dengan caption lama "8i Tahfidz" yang masuk ke mode default (bimbel).
export const HASHTAG_KATEGORI = {
    '#tka': 'tka',
    '#to': 'tryout',
    '#bimbel': 'bimbel',
    '#tahfidz': 'bimbel',
}

// Daftar command hashtag, dipakai handleGroupCommands untuk guard pesan.
export const HASHTAG_COMMANDS = Object.keys(HASHTAG_KATEGORI)

/**
 * Mem-parse caption foto ber-prefix command hashtag.
 *
 * @param {string} caption Caption dari imageMessage (atau teks pesan).
 * @returns {{kategori: string, metode: string, kelas: string, materi: string}|null}
 *          null jika bukan command hashtag atau argumen tidak lengkap.
 */
export const parseHashtagCaption = (caption) => {
    // Buang bagian @mention (merujuk guru, bukan konten) dan token kosong.
    const parts = String(caption || '')
        .trim()
        .split(/\s+/)
        .filter((part) => part !== '' && !part.startsWith('@'))

    if (parts.length === 0) return null

    const cmd = parts[0].toLowerCase()
    const kategori = HASHTAG_KATEGORI[cmd]
    if (!kategori) return null

    // Token 'daring' tepat setelah command memilih metode daring.
    const isDaring = (parts[1] || '').toLowerCase() === 'daring'
    const offset = isDaring ? 2 : 1

    const kelas = parts[offset] || ''
    const materi = parts.slice(offset + 1).join(' ')

    // Kelas dan materi wajib ada — konsisten dengan validasi mode caption lain.
    if (!kelas || !materi) return null

    return {
        kategori,
        metode: isDaring ? 'daring' : 'luring',
        kelas,
        materi,
    }
}
