/* eslint-disable arrow-body-style */
import {
    getSession,
    getChatList,
    isExists,
    sendMessage,
    formatGroup,
    formatPhone,
    getGroupsWithParticipants,
    participantsUpdate,
    updateSubject,
    updateDescription,
    settingUpdate,
    leave,
    inviteCode,
    acceptInvite,
    revokeInvite,
    profilePicture,
} from './../whatsapp.js'
import response from './../response.js'

const getList = (req, res) => {
    const session = getSession(res.locals.sessionId)
    return response(res, 200, true, '', getChatList(session, true))
}

const getListWithoutParticipants = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const groups = await getGroupsWithParticipants(session)
        return response(res, 200, true, '', groups)
    } catch {
        response(res, 500, false, 'Failed to get group list with participants.')
    }
}

const getGroupMetaData = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { jid } = req.params

    try {
        const data = await session.groupMetadata(jid)

        if (!data.id) {
            return response(res, 400, false, 'The group is not exists.')
        }

        response(res, 200, true, '', data)
    } catch {
        response(res, 500, false, 'Failed to get group metadata.')
    }
}

const create = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    const { groupName, participants } = req.body
    const participantsformat = participants.map((e) => formatPhone(e))
    try {
        const group = await session.groupCreate(groupName, participantsformat)
        response(res, 200, true, 'The group has been successfully created.', group)
    } catch {
        response(res, 500, false, 'Failed to create the group.')
    }
}

const send = async (req, res) => {
    const session = getSession(res.locals.sessionId)

    try {
        const receiver = formatGroup(req.params.jid)
        const { message } = req.body

        const exists = await isExists(session, receiver, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await sendMessage(session, receiver, message, {}, 0)

        response(res, 200, true, 'The message has been successfully sent.')
    } catch {
        response(res, 500, false, 'Failed to send the message.')
    }
}

const groupParticipantsUpdate = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const participants = req?.body?.participants
        const action = req?.body?.action
        const participantsFormat = participants.map((e) => formatPhone(e))

        const exists = await isExists(session, jid, true)
        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await participantsUpdate(session, jid, participantsFormat, action)
        response(res, 200, true, 'Update participants successfully.')
    } catch {
        response(res, 500, false, 'Failed to update participants.')
    }
}

const groupUpdateSubject = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const subject = req?.body?.subject
        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await updateSubject(session, jid, subject)

        response(res, 200, true, 'Update subject successfully.')
    } catch {
        response(res, 500, false, 'Failed to update subject.')
    }
}

const groupUpdateDescription = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const { description } = req.body
        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await updateDescription(session, jid, description)

        response(res, 200, true, 'Update description successfully.')
    } catch {
        response(res, 500, false, 'Failed to update description.')
    }
}

const groupSettingUpdate = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const settings = req?.body?.settings

        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await settingUpdate(session, jid, settings)

        response(res, 200, true, 'Update setting successfully.')
    } catch {
        response(res, 500, false, 'Failed to update setting.')
    }
}

const groupLeave = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await leave(session, jid)

        response(res, 200, true, 'Leave group successfully.')
    } catch {
        response(res, 500, false, 'Failed to leave group.')
    }
}

const groupInviteCode = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        const group = await inviteCode(session, jid)

        response(res, 200, true, 'Invite code successfully.', group)
    } catch {
        response(res, 500, false, 'Failed to get invite code.')
    }
}

const groupAcceptInvite = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const group = await acceptInvite(session, req.body)

        response(res, 200, true, 'Accept invite successfully.', group)
    } catch {
        response(res, 500, false, 'Failed to accept invite.')
    }
}

const groupRevokeInvite = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)

        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        const group = await revokeInvite(session, jid)

        response(res, 200, true, 'Revoke code successfully.', group)
    } catch {
        response(res, 500, false, 'Failed to revoke code.')
    }
}

const updateProfilePicture = async (req, res) => {
    const session = getSession(res.locals.sessionId)
    try {
        const jid = formatGroup(req.params.jid)
        const { url } = req.body
        const exists = await isExists(session, jid, true)

        if (!exists) {
            return response(res, 400, false, 'The group is not exists.')
        }

        await profilePicture(session, jid, url)
        response(res, 200, true, 'Update profile picture successfully.')
    } catch {
        response(res, 500, false, 'Failed to update profile picture.')
    }
}

export {
    getList,
    getGroupMetaData,
    create,
    send,
    groupParticipantsUpdate,
    groupUpdateSubject,
    groupUpdateDescription,
    groupSettingUpdate,
    groupLeave,
    groupInviteCode,
    groupAcceptInvite,
    groupRevokeInvite,
    getListWithoutParticipants,
    updateProfilePicture,
}
