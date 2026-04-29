/**
 * Group Manager Module
 * 
 * This module handles all group-related operations including:
 * - Group metadata retrieval
 * - Group participant management
 * - Group settings updates
 * - Group invite management
 */

import {
    info,
    success,
    error,
    debug,
} from '../utils/logger.js'

/**
 * Get all groups with their participants
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @returns {Promise<object>} Object containing all groups with participants
 */
const getGroupsWithParticipants = async (session) => {
    debug('GroupManager', 'Fetching all groups with participants')
    
    try {
        const result = await session.groupFetchAllParticipating()
        success('GroupManager', 'Groups fetched successfully', {
            groupCount: Object.keys(result).length,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to fetch groups', {
            error: err.message,
        })
        throw err
    }
}

/**
 * Update group participants (add, remove, promote, demote)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID
 * @param {Array<string>} participants - Array of participant JIDs
 * @param {string} action - Action to perform: 'add', 'remove', 'promote', 'demote'
 * @returns {Promise<object>} Result of participants update
 */
const participantsUpdate = async (session, jid, participants, action) => {
    info('GroupManager', 'Updating group participants', {
        groupId: jid,
        action,
        participantCount: participants.length,
    })
    
    try {
        const result = await session.groupParticipantsUpdate(jid, participants, action)
        success('GroupManager', 'Group participants updated successfully', {
            groupId: jid,
            action,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to update group participants', {
            groupId: jid,
            action,
            error: err.message,
        })
        throw err
    }
}

/**
 * Update group subject (name)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID
 * @param {string} subject - New group name
 * @returns {Promise<object>} Result of subject update
 */
const updateSubject = async (session, jid, subject) => {
    info('GroupManager', 'Updating group subject', {
        groupId: jid,
        subject,
    })
    
    try {
        const result = await session.groupUpdateSubject(jid, subject)
        success('GroupManager', 'Group subject updated successfully', {
            groupId: jid,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to update group subject', {
            groupId: jid,
            error: err.message,
        })
        throw err
    }
}

/**
 * Update group description
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID
 * @param {string} description - New group description
 * @returns {Promise<object>} Result of description update
 */
const updateDescription = async (session, jid, description) => {
    info('GroupManager', 'Updating group description', {
        groupId: jid,
    })
    
    try {
        const result = await session.groupUpdateDescription(jid, description)
        success('GroupManager', 'Group description updated successfully', {
            groupId: jid,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to update group description', {
            groupId: jid,
            error: err.message,
        })
        throw err
    }
}

/**
 * Update group settings (e.g., send messages, edit info)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID
 * @param {object} settings - Settings to update
 * @returns {Promise<object>} Result of settings update
 */
const settingUpdate = async (session, jid, settings) => {
    info('GroupManager', 'Updating group settings', {
        groupId: jid,
        settings,
    })
    
    try {
        const result = await session.groupSettingUpdate(jid, settings)
        success('GroupManager', 'Group settings updated successfully', {
            groupId: jid,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to update group settings', {
            groupId: jid,
            error: err.message,
        })
        throw err
    }
}

/**
 * Leave a group
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID to leave
 * @returns {Promise<object>} Result of leave operation
 */
const leave = async (session, jid) => {
    info('GroupManager', 'Leaving group', {
        groupId: jid,
    })
    
    try {
        const result = await session.groupLeave(jid)
        success('GroupManager', 'Left group successfully', {
            groupId: jid,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to leave group', {
            groupId: jid,
            error: err.message,
        })
        throw err
    }
}

/**
 * Get group invite code
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID
 * @returns {Promise<string>} The group invite code
 */
const inviteCode = async (session, jid) => {
    debug('GroupManager', 'Getting group invite code', {
        groupId: jid,
    })
    
    try {
        const result = await session.groupInviteCode(jid)
        success('GroupManager', 'Group invite code retrieved successfully', {
            groupId: jid,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to get group invite code', {
            groupId: jid,
            error: err.message,
        })
        throw err
    }
}

/**
 * Revoke group invite code
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The group JID
 * @returns {Promise<string>} The new invite code
 */
const revokeInvite = async (session, jid) => {
    info('GroupManager', 'Revoking group invite code', {
        groupId: jid,
    })
    
    try {
        const result = await session.groupRevokeInvite(jid)
        success('GroupManager', 'Group invite code revoked successfully', {
            groupId: jid,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to revoke group invite code', {
            groupId: jid,
            error: err.message,
        })
        throw err
    }
}

/**
 * Get group metadata
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} groupId - The group ID
 * @returns {Promise<object>} Group metadata object
 */
const metaData = async (session, groupId) => {
    debug('GroupManager', 'Getting group metadata', {
        groupId,
    })
    
    try {
        const result = await session.groupMetadata(groupId)
        success('GroupManager', 'Group metadata retrieved successfully', {
            groupId,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to get group metadata', {
            groupId,
            error: err.message,
        })
        throw err
    }
}

/**
 * Accept a group invite
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} invite - The invite code or link
 * @returns {Promise<object>} Result of accepting invite
 */
const acceptInvite = async (session, invite) => {
    info('GroupManager', 'Accepting group invite', {
        invite,
    })
    
    try {
        const result = await session.groupAcceptInvite(invite)
        success('GroupManager', 'Group invite accepted successfully', {
            invite,
        })
        return result
    } catch (err) {
        error('GroupManager', 'Failed to accept group invite', {
            invite,
            error: err.message,
        })
        throw err
    }
}

/**
 * Get list of chats filtered by type (individual or group)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {boolean} isGroup - True to get groups, false to get individual chats
 * @returns {Array<object>} Filtered list of chats
 */
const getChatList = (session, isGroup = false) => {
    const filter = isGroup ? '@g.us' : '@s.whatsapp.net'
    const chats = session.store.chats
    const result = [...chats.values()].filter((chat) => chat.id.endsWith(filter))
    
    debug('GroupManager', 'Retrieved chat list', {
        isGroup,
        chatCount: result.length,
    })
    
    return result
}

/**
 * Check if a JID exists (individual or group)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The JID to check
 * @param {boolean} isGroup - True if checking a group, false for individual
 * @returns {Promise<boolean>} True if exists, false otherwise
 */
const isExists = async (session, jid, isGroup = false) => {
    debug('GroupManager', 'Checking if JID exists', {
        jid,
        isGroup,
    })
    
    try {
        let result

        if (isGroup) {
            result = await session.groupMetadata(jid)
            const exists = Boolean(result.id)
            debug('GroupManager', 'Group existence check result', {
                jid,
                exists,
            })
            return exists
        }

        ;[result] = await session.onWhatsApp(jid)
        debug('GroupManager', 'Contact existence check result', {
            jid,
            exists: result.exists,
        })
        return result.exists
    } catch (err) {
        error('GroupManager', 'Failed to check JID existence', {
            jid,
            isGroup,
            error: err.message,
        })
        return false
    }
}

export {
    getGroupsWithParticipants,
    participantsUpdate,
    updateSubject,
    updateDescription,
    settingUpdate,
    leave,
    inviteCode,
    revokeInvite,
    metaData,
    acceptInvite,
    getChatList,
    isExists,
}
