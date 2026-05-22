import gtts from 'node-gtts'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

ffmpeg.setFfmpegPath(ffmpegPath)

const tts = gtts('id')

export const generateVoiceNote = async (
    text,
    outputName = Date.now()
) => {

    const mp3Path = `./src/temp/${outputName}.mp3`
    const oggPath = `./src/temp/${outputName}.ogg`

    // Generate mp3
    await new Promise((resolve, reject) => {

        tts.save(mp3Path, text, (err) => {

            if (err) return reject(err)

            resolve()

        })

    })

    // Convert ke ogg opus
    await new Promise((resolve, reject) => {

        ffmpeg(mp3Path)
            .audioCodec('libopus')
            .format('ogg')
            .save(oggPath)
            .on('end', resolve)
            .on('error', reject)

    })

    return {
        mp3Path,
        oggPath,
    }
}