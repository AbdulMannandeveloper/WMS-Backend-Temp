const crypto = require('crypto');

const userRepository = require('../repositories/user.repository');
const employeeRepository = require('../repositories/employee.repository');
const invitationTokenRepository = require('../repositories/invitation-token.repository');
const { enqueueMail } = require('../utils/mailQueue');
const { inviteEmailTemplate } = require('../utils/emailTemplates');

const INVITE_EXPIRY_HOURS = Number(process.env.INVITE_EXPIRY_HOURS || 24);
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://myapp.com';

const hashValue = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

/**
 * Generates a unique employee number: EMP-XXXXXXXX
 * (8 uppercase hex chars, max 12 chars, fits VarChar(30))
 */
const generateEmployeeNumber = () =>
  'EMP-' + crypto.randomBytes(4).toString('hex').toUpperCase();

/**
 * Admin adds a new employee.
 *
 * At invite-time, only basic identity info is required:
 *   adminId     - ID of the requesting admin
 *   firstName   - Employee's first name
 *   lastName    - Employee's last name
 *   email       - Employee's email (used for login + invitation)
 *
 * Detailed fields (jobTitle, nationalInsuranceNumber, dateOfBirth,
 * wageRate, address) are left NULL — they can be filled in later.
 *
 * Flow:
 *  1. Validate admin
 *  2. Create User record (role = employee, isActive = false)
 *  3. Create Employee record (only userId + employeeUniqueNumber set)
 *  4. Generate InvitationToken
 *  5. Send setup-password email (US-005 / US-011 pattern)
 */
const addEmployee = async ({ adminId, firstName, lastName, email }) => {
  // --- Validate admin ---
  if (!adminId) {
    throw new Error('adminId is required.');
  }
  const admin = await userRepository.getUserByField('id', adminId);
  if (!admin || admin.role !== 'admin' || !admin.isActive) {
    throw new Error('Only an active admin can add employees.');
  }

  // --- Validate required fields ---
  if (!firstName || !lastName || !email) {
    throw new Error('firstName, lastName, and email are required.');
  }

  if (!/\S+@\S+\.\S+/.test(email)) {
    throw new Error('Invalid email format.');
  }

  // --- Check for duplicate email ---
  const existingUser = await userRepository.getUserByField('email', email);
  if (existingUser) {
    throw new Error('A user with this email already exists.');
  }

  // --- Create the User record ---
  const newUser = await userRepository.createUser({
    firstName,
    lastName,
    email,
    role: 'employee',
    isActive: false,
    passwordHash: null,
  });

  try {
    // --- Create the Employee record (detailed fields left null for now) ---
    const newEmployee = await employeeRepository.createEmployee({
      userId: newUser.id,
      employeeUniqueNumber: generateEmployeeNumber(),
      // jobTitle, nationalInsuranceNumber, dateOfBirth, wageRate, address
      // are all nullable — will be filled in later
    });

    // --- Generate InvitationToken and send setup-password email ---
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
      employeeId: newEmployee.id,
      employeeUniqueNumber: newEmployee.employeeUniqueNumber,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
    };
  } catch (error) {
    // Roll back user on any failure inside the try block
    await userRepository.deleteUser(newUser.id).catch(() => null);
    throw new Error(error.message);
  }
};

/**
 * Get all employees.
 */
const getAllEmployees = async () => {
  return await employeeRepository.getAllEmployees();
};

/**
 * Get a single employee by their employee record ID.
 */
const getEmployeeById = async (employeeId) => {
  const employee = await employeeRepository.getEmployeeByField('id', employeeId);
  if (!employee) {
    throw new Error('Employee not found.');
  }
  return employee;
};

module.exports = {
  addEmployee,
  getAllEmployees,
  getEmployeeById,
};
