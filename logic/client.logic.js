const crypto = require('crypto');

const userRepository = require('../repositories/user.repository');
const clientRepository = require('../repositories/client.repository');
const invitationTokenRepository = require('../repositories/invitation-token.repository');
const auditLogLogic = require('./audit_log.logic');
const { prisma } = require('../lib/prisma');
const { invalidateCachedUser } = require('../utils/authUserCache');
const { buildReport, assertDeletable } = require('../utils/dependents');
const { enqueueMail } = require('../utils/mailQueue');
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
 *   mobile       - (optional) Mobile / phone number (also accepts legacy "phone")
 *   address      - (optional) Business address
 *
 * firstName / lastName are derived from contactName for the User record
 * (split on first space; everything after becomes lastName).
 */
const addClient = async ({ adminId, companyName, contactName, email, mobile, phone, address }) => {
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
      mobile: mobile || phone || null,
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

    enqueueMail({
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

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
  const clients = await clientRepository.getAllClientsWithAccount();
  // The login's state rides along so the list can show who is switched off.
  // passwordHash is read only to tell "never accepted the invite" apart from
  // "deactivated" — it never leaves this function.
  return clients.map(({ user, ...client }) => ({
    ...client,
    accountStatus: !user?.passwordHash ? 'pending' : user.isActive ? 'active' : 'inactive',
  }));
};

/**
 * Slim id + companyName list for dropdowns.
 * Used by employees, who need to attribute a product to a client but have no
 * business seeing client contact details, addresses or negotiated rates.
 */
const getClientLookupList = async () => {
  const clients = await clientRepository.getAllClients();
  return clients.map(({ id, companyName }) => ({ id, companyName }));
};

/**
 * Get the client record linked to a given user login.
 */
const getClientByUserId = async (userId) => {
  const client = await clientRepository.getClientByField('userId', userId);
  if (!client) {
    throw new Error('No client account is linked to this login.');
  }
  return client;
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

  // The contact email is also the login. Changing one without the other left
  // the client signing in with an address the admin had already replaced.
  const emailChanged =
    typeof dataToUpdate.email === 'string' && dataToUpdate.email !== client.email;
  if (emailChanged) {
    if (!/\S+@\S+\.\S+/.test(dataToUpdate.email)) {
      throw new Error('Invalid email format.');
    }
    const taken = await userRepository.getUserByField('email', dataToUpdate.email);
    if (taken && taken.id !== client.userId) {
      throw new Error('A user with this email already exists.');
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (emailChanged) {
      await tx.user.update({ where: { id: client.userId }, data: { email: dataToUpdate.email } });
    }
    return tx.client.update({ where: { id: clientId }, data: dataToUpdate });
  });
  if (emailChanged) {
    await invalidateCachedUser(client.userId);
  }
  return updated;
};

/**
 * Everything that still refers to a client, for the warning shown before a
 * delete. See utils/dependents.js for what blocking and removedWith mean.
 *
 * Products block rather than cascade. The FK would take them and their stock
 * silently, but one with movement history cannot go at all (the ledger is
 * Restrict), and one with stock on a shelf should not vanish without somebody
 * deciding it should. Product delete already knows how to judge each one.
 */
const getClientDependents = async (clientId) => {
  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) {
    const err = new Error('Client not found.');
    err.status = 404;
    throw err;
  }

  const [products, shipments, fbaShipments, invoices, returns, ledgerRows, clientServices] =
    await Promise.all([
      prisma.product.count({ where: { clientId } }),
      prisma.shipment.count({ where: { clientId } }),
      prisma.fbaShipment.count({ where: { clientId } }),
      prisma.monthlyInvoice.count({ where: { clientId } }),
      prisma.productReturn.count({ where: { clientId } }),
      prisma.inventoryLedger.count({ where: { userId: client.userId } }),
      prisma.clientService.count({ where: { clientId } }),
    ]);

  return {
    client,
    report: buildReport({
      blocking: [
        { key: 'products', label: 'Products', count: products, where: '/inventory' },
        { key: 'shipments', label: 'Shipments', count: shipments, where: '/shipments' },
        { key: 'fbaShipments', label: 'Bulk shipments', count: fbaShipments, where: '/fba' },
        { key: 'invoices', label: 'Invoices', count: invoices, where: '/invoices' },
        { key: 'returns', label: 'Returns', count: returns, where: '/returns' },
        {
          key: 'ledger',
          label: 'Stock movements recorded by this login',
          count: ledgerRows,
          note: 'Ledger history is permanent. Deactivate this client instead.',
        },
      ],
      removedWith: [
        { key: 'clientServices', label: 'Agreed service rates', count: clientServices },
      ],
    }),
  };
};

/**
 * Switches a client's login off or back on, keeping every record.
 *
 * The reversible alternative to deleting, and the only option once a client has
 * history. Switching off ends the sessions they already hold.
 */
const setClientActive = async (clientId, isActive, actorUserId) => {
  if (typeof isActive !== 'boolean') {
    throw new Error('isActive must be true or false.');
  }
  const client = await clientRepository.getClientByField('id', clientId);
  if (!client) {
    const err = new Error('Client not found.');
    err.status = 404;
    throw err;
  }
  const user = await userRepository.getUserByField('id', client.userId);
  if (!user?.passwordHash) {
    throw new Error(
      'This client has not set up their password yet, so there is no login to deactivate. Delete the client instead if they are not needed.',
    );
  }

  if (user.isActive !== isActive) {
    await userRepository.updateUser(user.id, {
      isActive,
      // Bumping the version is what ends live sessions; see User.tokenVersion.
      ...(isActive ? {} : { tokenVersion: (user.tokenVersion ?? 0) + 1 }),
    });
    await invalidateCachedUser(user.id);

    if (actorUserId) {
      await auditLogLogic.createAuditLog(
        actorUserId,
        isActive ? 'REACTIVATE_CLIENT' : 'DEACTIVATE_CLIENT',
        { clientId, companyName: client.companyName },
      ).catch((err) => console.error('Audit log error:', err.message));
    }
  }

  return { ...client, accountStatus: isActive ? 'active' : 'inactive' };
};

/**
 * Deletes a client that has nothing left on record.
 *
 * Deleting the login is what deletes the client: Client.user cascades, and so
 * do their agreed rates, invitation tokens and OTPs. Deleting only the Client
 * row, as this used to, left a client-role login behind with no client on it.
 *
 * @throws {HasDependentsError} (409) while anything in getClientDependents blocks
 */
const deleteClient = async (clientId, actorUserId) => {
  if (!clientId) {
    throw new Error('clientId is required.');
  }

  const { client, report } = await getClientDependents(clientId);
  assertDeletable(client.companyName, report, { deactivatable: true });

  await prisma.$transaction(async (tx) => {
    // Their audit entries outlive the login (AuditLog.user is SetNull), so
    // they are named before the link is cleared.
    await tx.auditLog.updateMany({
      where: { userId: client.userId },
      data: { actorName: `${client.contactName} (${client.companyName}, deleted)`.slice(0, 120) },
    });
    await tx.user.delete({ where: { id: client.userId } });
  });
  await invalidateCachedUser(client.userId);

  if (actorUserId) {
    await auditLogLogic.createAuditLog(actorUserId, 'DELETE_CLIENT', {
      clientId,
      clientUniqueNumber: client.clientUniqueNumber,
      companyName: client.companyName,
      email: client.email,
    }).catch((err) => console.error('Audit log error:', err.message));
  }

  return client;
};

module.exports = {
  addClient,
  getAllClients,
  getClientLookupList,
  getClientByUserId,
  getClientById,
  updateClient,
  getClientDependents,
  setClientActive,
  deleteClient,
};
