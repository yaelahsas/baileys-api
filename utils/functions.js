import fs from 'fs'

const compareAndFilter = (array1, array2) => {
    return array1.filter((item) => {
        return array2.includes(item)
    })
}

const isUrlValid = (url) => {
    return Boolean(
        /^(?:(?:(?:https?|ftp):)\/\/)(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]-*)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(
            url
        )
    )
}

const fileExists = (path) => {
    return Boolean(fs.existsSync(path))
}

/**
 * Deteksi apakah string adalah data-URI base64 (mis. 'data:image/jpeg;base64,...').
 *
 * Media dapat dikirim tanpa URL jaringan: Baileys mendekode data-URI menjadi
 * Buffer langsung (lihat getStream() di messages-media.js), sehingga gateway
 * TIDAK perlu meng-fetch apa pun. Ini menghindari kegagalan fetch ke URL publik
 * yang berada di belakang Cloudflare (penyebab 'Failed to fetch stream').
 */
const isDataUri = (str) => {
    return Boolean(
        typeof str === 'string' &&
        /^data:[\w./+-]+;base64,[A-Za-z0-9+/=]+$/.test(str)
    )
}

const deleteFile = async (path) => {
    return new Promise((resolve, reject) => {
        fs.unlink(path, (err) => {
            err ? reject(err) : resolve(true)
        })
    })
}

export { compareAndFilter, isUrlValid, fileExists, isDataUri, deleteFile }
