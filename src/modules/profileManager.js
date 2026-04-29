/**
 * Profile Manager Module
 * 
 * This module handles all profile-related operations including:
 * - Profile picture management
 * - Profile status updates
 * - Profile name updates
 * - User blocking/unblocking
 */

import { downloadImage } from '../../utils/download.js'
import {
    info,
    success,
    error,
    debug,
} from '../utils/logger.js'

/**
 * Update profile status (about text)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} status - New status text
 * @returns {Promise<object>} Result of status update
 */
const updateProfileStatus = async (session, status) => {
    info('ProfileManager', 'Updating profile status', {
        statusLength: status.length,
    })
    
    try {
        const result = await session.updateProfileStatus(status)
        success('ProfileManager', 'Profile status updated successfully')
        return result
    } catch (err) {
        error('ProfileManager', 'Failed to update profile status', {
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Update profile name (display name)
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} name - New profile name
 * @returns {Promise<object>} Result of name update
 */
const updateProfileName = async (session, name) => {
    info('ProfileManager', 'Updating profile name', {
        name,
        nameLength: name.length,
    })
    
    try {
        const result = await session.updateProfileName(name)
        success('ProfileManager', 'Profile name updated successfully', {
            name,
        })
        return result
    } catch (err) {
        error('ProfileManager', 'Failed to update profile name', {
            name,
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Get profile picture URL
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The JID of contact/group
 * @param {string} type - Image type: 'image' or 'preview'
 * @returns {Promise<string>} URL of profile picture
 */
const getProfilePicture = async (session, jid, type = 'image') => {
    debug('ProfileManager', 'Getting profile picture', {
        jid,
        type,
    })
    
    try {
        const result = await session.profilePictureUrl(jid, type)
        success('ProfileManager', 'Profile picture retrieved successfully', {
            jid,
            type,
        })
        return result
    } catch (err) {
        error('ProfileManager', 'Failed to get profile picture', {
            jid,
            type,
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Update profile picture
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The JID to update (self or group)
 * @param {string} urlImage - URL of new profile picture
 * @returns {Promise<object>} Result of profile picture update
 */
const profilePicture = async (session, jid, urlImage) => {
    info('ProfileManager', 'Updating profile picture', {
        jid,
        imageUrl: urlImage,
    })
    
    try {
        const image = await downloadImage(urlImage)
        debug('ProfileManager', 'Image downloaded successfully', {
            jid,
        })
        
        const result = await session.updateProfilePicture(jid, { url: image })
        success('ProfileManager', 'Profile picture updated successfully', {
            jid,
        })
        return result
    } catch (err) {
        error('ProfileManager', 'Failed to update profile picture', {
            jid,
            imageUrl: urlImage,
            error: err.message,
        })
        return Promise.reject(null)
    }
}

/**
 * Block or unblock a user
 * 
 * @param {import('baileys').AnyWASocket} session - The WhatsApp session
 * @param {string} jid - The JID of user to block/unblock
 * @param {string} block - Action: 'block' or 'unblock'
 * @returns {Promise<object>} Result of block/unblock operation
 */
const blockAndUnblockUser = async (session, jid, block) => {
    info('ProfileManager', `${block === 'block' ? 'Blocking' : 'Unblocking'} user`, {
        jid,
        action: block,
    })
    
    try {
        const result = await session.updateBlockStatus(jid, block)
        success('ProfileManager', `User ${block === 'block' ? 'blocked' : 'unblocked'} successfully`, {
            jid,
            action: block,
        })
        return result
    } catch (err) {
        error('ProfileManager', `Failed to ${block === 'block' ? 'block' : 'unblock'} user`, {
            jid,
            action: block,
            error: err.message,
        })
        return Promise.reject(null)
    }
}

export {
    updateProfileStatus,
    updateProfileName,
    getProfilePicture,
    profilePicture,
    blockAndUnblockUser,
}
