/**
 * Formatters Utility Module
 * 
 * This module provides utility functions for formatting:
 * - Phone numbers to WhatsApp JID format
 * - Group IDs to WhatsApp JID format
 * - Phone numbers to LinkedIn-style @lid format
 */

/**
 * Format a phone number to WhatsApp JID format
 * 
 * @param {string} phone - The phone number to format
 * @returns {string} Formatted phone number as WhatsApp JID
 * 
 * @example
 * formatPhone('628123456789') // returns '628123456789@s.whatsapp.net'
 * formatPhone('628123456789@s.whatsapp.net') // returns '628123456789@s.whatsapp.net'
 */
const formatPhone = (phone) => {
    if (phone.endsWith('@s.whatsapp.net')) {
        return phone
    }

    let formatted = phone.replace(/\D/g, '')

    return (formatted += '@s.whatsapp.net')
}

/**
 * Format a group ID to WhatsApp JID format
 * 
 * @param {string} group - The group ID to format
 * @returns {string} Formatted group ID as WhatsApp JID
 * 
 * @example
 * formatGroup('1234567890') // returns '1234567890@g.us'
 * formatGroup('1234567890@g.us') // returns '1234567890@g.us'
 */
const formatGroup = (group) => {
    if (group.endsWith('@g.us')) {
        return group
    }

    let formatted = group.replace(/[^\d-]/g, '')

    return (formatted += '@g.us')
}

/**
 * Format a phone number to LinkedIn-style @lid format
 * 
 * This format is used in WhatsApp's new addressing mode (addressingMode: 'lid')
 * 
 * @param {string} phone - The phone number to format
 * @returns {string} Formatted phone number as @lid
 * 
 * @example
 * formatLid('628123456789') // returns '628123456789@lid'
 * formatLid('628123456789@lid') // returns '628123456789@lid'
 */
const formatLid = (phone) => {
    if (phone.endsWith('@lid')) {
        return phone
    }

    let formatted = phone.replace(/\D/g, '')

    return (formatted += '@lid')
}

export {
    formatPhone,
    formatGroup,
    formatLid,
}
