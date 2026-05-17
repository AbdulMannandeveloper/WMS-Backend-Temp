const crypto = require('crypto');

const userRepository = require('../repositories/user.repository');
const clientRepository = require('../repositories/client.repository');
const invitationTokenRepository = require('../repositories/invitation-token.repository');
const { sendMail } = require('../utils/mailer');
const { inviteEmailTemplate } = require('../utils/emailTemplates');

const INVITE_EXPIRY_HOURS = Number(process.env.INVITE_EXPIRY_HOURS || 24);
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://myapp.com';

const hashValue = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

/**
 * Generates a unique client number: CLT-XXXXXXXX
 * (8 uppercase hex chars = 4 billion+ combinations, max 12 chars, fits VarChar(30))
 */
const generateClientNumber = () =>
  'CLT-' + crypto.randomBytes(4).toString('hex').toUpperCase();

/**
 * US-010 & US-011
 * Admin adds a new client (business details) → User + Client records created
 * → invitation email with password-setup link sent automatically.
 *
 * Required body fields:
 *   adminId      - ID of the requesting admin
 *   companyName  - Client's business/company name
 *   contactName  - Primary contact person name
 *   email        - Contact email (used for login + email)
 *   phone        - (optional) Mobile / phone number
 *   address      - (optional) Business address
 *
 * firstName / lastName are derived from contactName for the User record
 * (split on first space; everything after becomes lastName).
 */
const addClient = async ({ adminId, companyName, contactName, email, phone, address }) => {
  // --- Validate admin ---
  if (!adminId) {
    throw new Error('adminId is required.');
  }
  const admin = await userRepository.getUserByField('id', adminId);
  if (!admin || admin.role !== 'admin' || !admin.isActive) {
    throw new Error('Only an active admin can add clients.');
  }

  // --- Validate required fields ---
  if (!companyName || !contactName || !email) {
    throw new Error('companyName, contactName, and email are required.');
  }

  if (!/\S+@\S+\.\S+/.test(email)) {
    throw new Error('Invalid email format.');
  }

  // --- Derive firstName / lastName from contactName ---
  const nameParts = contactName.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '.';

  // --- Check for duplicate email ---
  const existingUser = await userRepository.getUserByField('email', email);
  if (existingUser) {
    throw new Error('A user with this email already exists.');
  }

  // --- Create the User record (role = client, inactive until password set) ---
  const newUser = await userRepository.createUser({
    firstName,
    lastName,
    email,
    role: 'client',
    isActive: false,
    passwordHash: null,
  });

  try {
    // --- Create the Client business-details record ---
    const newClient = await clientRepository.createClient({
      userId: newUser.id,
      clientUniqueNumber: generateClientNumber(),
      companyName,
      contactName,
      email,
      mobile: phone || null,
      address: address || null,
    });

    // --- US-011: Generate invitation token and send email ---
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashValue(plainToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

    await invitationTokenRepository.createInvitationToken({
      userId: newUser.id,
      tokenHash,
      expiresAt,
    });

    const setupUrl = `${APP_BASE_URL}/setup-password?token=${plainToken}`;
    const emailContent = inviteEmailTemplate({ setupUrl, expiresHours: INVITE_EXPIRY_HOURS });

    const sent = await sendMail({
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (!sent) {
      // Roll back user and client records if email fails
      await clientRepository.deleteClient(newClient.id).catch(() => null);
      await userRepository.deleteUser(newUser.id).catch(() => null);
      throw new Error('Failed to send invitation email. Client creation rolled back.');
    }

    return {
      userId: newUser.id,
      clientId: newClient.id,
      email: newUser.email,
      companyName: newClient.companyName,
      contactName: newClient.contactName,
    };
  } catch (error) {
    // Roll back user on any failure inside the try block
    await userRepository.deleteUser(newUser.id).catch(() => null);
    throw new Error(error.message);
  }
};

/**
 * Get all clients (with their linked user data).
 */
const getAllClients = async () => {
  return await clientRepository.getAllClients();
};

/**
 * Get a single client by their client record ID.
 */
const getClientById = async (clientId) => {
  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) {
    throw new Error('Client not found.');
  }
  return client;
};

/**
 * Update client details.
 */
const updateClient = async (clientId, updateData) => {
  if (!clientId) {
    throw new Error('clientId is required.');
  }

  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) {
    throw new Error('Client not found.');
  }

  // Update allowed fields
  const allowedFields = ['companyName', 'contactName', 'email', 'mobile', 'address'];
  const dataToUpdate = {};
  for (const field of allowedFields) {
    if (field in updateData) {
      dataToUpdate[field] = updateData[field];
    }
  }

  if (Object.keys(dataToUpdate).length === 0) {
    return client;
  }

  return await clientRepository.updateClient(clientId, dataToUpdate);
};

/**
 * Delete client record.
 */
const deleteClient = async (clientId) => {
  if (!clientId) {
    throw new Error('clientId is required.');
  }

  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) {
    throw new Error('Client not found.');
  }

  return await clientRepository.deleteClient(clientId);
};

module.exports = {
  addClient,
  getAllClients,
  getClientById,
  updateClient,
  deleteClient,
};
