const crypto = require('crypto');

const userRepository = require('../repositories/user.repository');
const employeeRepository = require('../repositories/employee.repository');
const auditLogLogic = require('./audit_log.logic');
const { toUtcDateOnly } = require('../utils/dates');
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
 * Names and ids only, for populating a dropdown.
 *
 * The full Employee record carries a National Insurance number, date of birth,
 * home address and salary. Staff need to pick an operator when raising a
 * shipment; they do not need any of that, and sending it to a browser to render
 * a <select> would be a disclosure with no purpose. Mirrors
 * getClientLookupList().
 */
const getEmployeeLookupList = async () => {
  const employees = await employeeRepository.getAllEmployees();
  return employees.map(({ id, user }) => ({
    id,
    firstName: user?.firstName ?? null,
    lastName: user?.lastName ?? null,
  }));
};

/**
 * Get a single employee by their employee record ID.
 *
 * Scoped: an employee may read only their own record. Without this any member
 * of staff could read a colleague's NI number, date of birth, home address and
 * salary by walking ids — the route has always allowed the employee role.
 */
const getEmployeeById = async (employeeId, actor) => {
  const employee = await employeeRepository.getEmployeeByField('id', employeeId);
  if (!employee) {
    throw new Error('Employee not found.');
  }

  if (actor && actor.role !== 'admin' && employee.userId !== actor.id) {
    const err = new Error('You may only view your own employee record.');
    err.status = 403;
    throw err;
  }

  return employee;
};

/**
 * Fields an admin may change on an employment record.
 *
 * baseSalary is deliberately absent. Payroll owns it, through
 * PUT /api/payroll/employees/:id/base-salary, and it is the figure payroll
 * multiplies out into net pay — two screens writing one number is how they end
 * up disagreeing. userId and employeeUniqueNumber are absent for the same
 * reason the client-service allowlist exists: a request body should not be able
 * to move a record onto a different person.
 */
const EMPLOYEE_UPDATE_FIELDS = [
  'jobTitle',
  'nationalInsuranceNumber',
  'dateOfBirth',
  'wageRate',
  'address',
];

/**
 * Updates an employment record.
 *
 * These are the columns the schema has always had and nothing could write:
 * there was no update endpoint at all, so job title, NI number, date of birth,
 * wage rate and address could never be filled in.
 */
const updateEmployee = async (id, rawUpdateData, actorUserId) => {
  const employee = await employeeRepository.getEmployeeByField('id', id);
  if (!employee) {
    throw new Error('Employee not found.');
  }

  const updateData = {};
  for (const field of EMPLOYEE_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawUpdateData, field)) {
      updateData[field] = rawUpdateData[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    return employee;
  }

  // Blanks clear a field rather than storing an empty string, so an NI number
  // removed in the UI does not collide with the next empty one on the unique
  // index.
  for (const field of ['jobTitle', 'nationalInsuranceNumber', 'address']) {
    if (typeof updateData[field] === 'string') {
      const trimmed = updateData[field].trim();
      updateData[field] = trimmed === '' ? null : trimmed;
    }
  }

  if (updateData.wageRate !== undefined && updateData.wageRate !== null) {
    const rate = Number(updateData.wageRate);
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error('Wage rate must be a number of zero or more.');
    }
    updateData.wageRate = rate;
  }

  if (updateData.dateOfBirth !== undefined && updateData.dateOfBirth !== null) {
    const dob = new Date(updateData.dateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      throw new Error('Date of birth is not a valid date.');
    }
    if (dob > new Date()) {
      throw new Error('Date of birth cannot be in the future.');
    }
    // @db.Date built from local time stores the previous day east of UTC.
    updateData.dateOfBirth = toUtcDateOnly(dob);
  }

  try {
    const updated = await employeeRepository.updateEmployee(id, updateData);

    await auditLogLogic
      .createAuditLog(actorUserId, 'EMPLOYEE_UPDATED', {
        employeeId: id,
        changed: Object.keys(updateData),
      })
      .catch((err) => console.error('Audit log error:', err.message));

    return updated;
  } catch (err) {
    // nationalInsuranceNumber is @unique. Left to Prisma this surfaces as a
    // 500 with a constraint name, which tells an admin nothing about what to do.
    if (err.code === 'P2002') {
      throw new Error(
        'That National Insurance number is already recorded against another employee.',
      );
    }
    throw err;
  }
};

module.exports = {
  addEmployee,
  getAllEmployees,
  getEmployeeLookupList,
  getEmployeeById,
  updateEmployee,
  EMPLOYEE_UPDATE_FIELDS,
};
