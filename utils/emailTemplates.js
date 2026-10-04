const otpEmailTemplate = ({ otp, expiresMinutes }) => {
  const subject = 'Your Pro Packers UK verification code';
  const text = `Your verification code is ${otp}. It expires in ${expiresMinutes} minutes.`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin: 0 0 12px;">Verify Your Email</h2>
      <p style="margin: 0 0 16px;">Use this one-time code to complete your verification:</p>
      <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; margin: 0 0 16px;">${otp}</div>
      <p style="margin: 0 0 8px;">This code expires in <strong>${expiresMinutes} minutes</strong>.</p>
      <p style="margin: 0; color: #6b7280;">If you did not request this code, you can ignore this email.</p>
    </div>
  `;

  return { subject, text, html };
};

const inviteEmailTemplate = ({ setupUrl, expiresHours }) => {
  const subject = 'Set Your Pro Packers UK Account Password';
  const text = `Your account has been created. Set your password here: ${setupUrl}. This link expires in ${expiresHours} hours.`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin: 0 0 12px;">Complete Your Account Setup</h2>
      <p style="margin: 0 0 16px;">An administrator created your account. Click below to set your password.</p>
      <p style="margin: 0 0 20px;">
        <a href="${setupUrl}" style="background: #0f766e; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 6px; display: inline-block;">Set Password</a>
      </p>
      <p style="margin: 0 0 8px;">This link expires in <strong>${expiresHours} hours</strong>.</p>
      <p style="margin: 0; color: #6b7280;">If the button does not work, paste this URL in your browser: ${setupUrl}</p>
    </div>
  `;

  return { subject, text, html };
};

const resetPasswordEmailTemplate = ({ setupUrl, expiresHours }) => {
  const subject = 'Reset Your Pro Packers UK Password';
  const text = `A password reset was requested for your account. Reset your password here: ${setupUrl}. This link expires in ${expiresHours} hours. If you did not request this, please ignore this email.`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin: 0 0 12px;">Reset Your Password</h2>
      <p style="margin: 0 0 16px;">An administrator has requested a password reset for your account. Click below to choose a new password.</p>
      <p style="margin: 0 0 20px;">
        <a href="${setupUrl}" style="background: #b45309; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 6px; display: inline-block;">Reset Password</a>
      </p>
      <p style="margin: 0 0 8px;">This link expires in <strong>${expiresHours} hours</strong>.</p>
      <p style="margin: 0 0 8px; color: #6b7280;">If the button does not work, paste this URL in your browser: ${setupUrl}</p>
      <p style="margin: 0; color: #6b7280;">If you did not request a password reset, you can safely ignore this email.</p>
    </div>
  `;

  return { subject, text, html };
};

// US-090: Sent to the client when their monthly invoice is approved by admin
const invoiceApprovedEmailTemplate = ({ companyName, billingMonth, totalAmount, portalUrl }) => {
  const subject = `Your Pro Packers UK Invoice for ${billingMonth} is Ready`;
  const formattedAmount = Number(totalAmount).toFixed(2);
  const text = `Dear ${companyName}, your invoice for ${billingMonth} totalling £${formattedAmount} has been approved and is ready to view. Log in to your portal here: ${portalUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin: 0 0 12px;">Your Invoice is Ready</h2>
      <p style="margin: 0 0 16px;">Dear <strong>${companyName}</strong>,</p>
      <p style="margin: 0 0 16px;">
        Your monthly invoice for <strong>${billingMonth}</strong> has been reviewed and approved.
      </p>
      <table style="border-collapse: collapse; margin: 0 0 20px;">
        <tr>
          <td style="padding: 6px 16px 6px 0; color: #6b7280;">Billing Period</td>
          <td style="padding: 6px 0; font-weight: bold;">${billingMonth}</td>
        </tr>
        <tr>
          <td style="padding: 6px 16px 6px 0; color: #6b7280;">Total Amount</td>
          <td style="padding: 6px 0; font-weight: bold; font-size: 18px;">£${formattedAmount}</td>
        </tr>
      </table>
      <p style="margin: 0 0 20px;">Log in to your client portal to view the full itemised breakdown:</p>
      <p style="margin: 0 0 20px;">
        <a href="${portalUrl}" style="background: #0f766e; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 6px; display: inline-block;">View Invoice</a>
      </p>
      <p style="margin: 0; color: #6b7280;">If the button does not work, paste this URL in your browser: ${portalUrl}</p>
    </div>
  `;

  return { subject, text, html };
};

// Sent when an admin edits an already-approved invoice's charges or tax, so a
// client who already saw (or downloaded) the original is not the last to know
// the total moved.
const invoiceUpdatedEmailTemplate = ({ companyName, billingMonth, totalAmount, portalUrl }) => {
  const subject = `Your Pro Packers UK Invoice for ${billingMonth} Has Been Updated`;
  const formattedAmount = Number(totalAmount).toFixed(2);
  const text = `Dear ${companyName}, your invoice for ${billingMonth} has been updated and now totals £${formattedAmount}. View the revised invoice here: ${portalUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
      <h2 style="margin: 0 0 12px;">Your Invoice Has Been Updated</h2>
      <p style="margin: 0 0 16px;">Dear <strong>${companyName}</strong>,</p>
      <p style="margin: 0 0 16px;">
        Your monthly invoice for <strong>${billingMonth}</strong> has been revised since it was approved.
      </p>
      <table style="border-collapse: collapse; margin: 0 0 20px;">
        <tr>
          <td style="padding: 6px 16px 6px 0; color: #6b7280;">Billing Period</td>
          <td style="padding: 6px 0; font-weight: bold;">${billingMonth}</td>
        </tr>
        <tr>
          <td style="padding: 6px 16px 6px 0; color: #6b7280;">Revised Total</td>
          <td style="padding: 6px 0; font-weight: bold; font-size: 18px;">£${formattedAmount}</td>
        </tr>
      </table>
      <p style="margin: 0 0 20px;">Log in to your client portal to view the updated breakdown:</p>
      <p style="margin: 0 0 20px;">
        <a href="${portalUrl}" style="background: #0f766e; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 6px; display: inline-block;">View Invoice</a>
      </p>
      <p style="margin: 0; color: #6b7280;">If the button does not work, paste this URL in your browser: ${portalUrl}</p>
    </div>
  `;

  return { subject, text, html };
};

const MILESTONE_COPY = {
  DISPATCHED: 'has been dispatched',
  LANDED: 'has landed',
  CUSTOMS_HOLD: 'is being held by customs',
  CLEARED: 'has cleared customs',
  RECEIPT_CLOSED: 'has been received at our hub',
  COMPLETED: 'has been fully handed over to the couriers',
};

/** A milestone update for a client who opted into air freight notifications. */
const airFreightMilestoneEmailTemplate = ({ companyName, flight, milestone, shortCount = 0, portalUrl = '' }) => {
  const what = MILESTONE_COPY[milestone] || `was updated (${milestone})`;
  const route = `${flight.originLocation} → ${flight.destinationLocation}`;
  const shortLine = milestone === 'RECEIPT_CLOSED' && shortCount > 0
    ? ` ${shortCount} box(es) did not arrive and are shown as short in the portal.`
    : '';
  const subject = `Air freight ${flight.reference}: ${what}`;
  const text = `Hello ${companyName},\n\nYour air freight flight ${flight.reference} (${route}) ${what}.${shortLine}\n\n${portalUrl ? `Track it: ${portalUrl}/client/air-freight/${flight.id}\n\n` : ''}Pro Packers`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827;">
      <p>Hello ${companyName},</p>
      <p>Your air freight flight <strong>${flight.reference}</strong> (${route}) ${what}.${shortLine}</p>
      ${portalUrl ? `<p><a href="${portalUrl}/client/air-freight/${flight.id}">View it in your portal</a></p>` : ''}
      <p style="color:#6b7280;">Pro Packers</p>
    </div>`;
  return { subject, text, html };
};

/** Tells a client an exception on their flight needs their decision. */
const airFreightExceptionEmailTemplate = ({ companyName, flight, exceptionType, clientNote, portalUrl = '' }) => {
  const label = String(exceptionType || 'issue').replace(/_/g, ' ').toLowerCase();
  const subject = `Air freight ${flight.reference}: your decision needed`;
  const text = `Hello ${companyName},\n\nA box on flight ${flight.reference} has a ${label} and needs your decision (ship as-is, hold, return, or send a new label).${clientNote ? `\n\nNote: ${clientNote}` : ''}\n\n${portalUrl ? `Decide in your portal: ${portalUrl}/client/air-freight/${flight.id}\n\n` : ''}Pro Packers`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #111827;">
      <p>Hello ${companyName},</p>
      <p>A box on flight <strong>${flight.reference}</strong> has a <strong>${label}</strong> and needs your decision — ship as-is, hold, return, or send a new label.</p>
      ${clientNote ? `<p style="color:#6b7280;">Note: ${clientNote}</p>` : ''}
      ${portalUrl ? `<p><a href="${portalUrl}/client/air-freight/${flight.id}">Decide in your portal</a></p>` : ''}
      <p style="color:#6b7280;">Pro Packers</p>
    </div>`;
  return { subject, text, html };
};

module.exports = {
  otpEmailTemplate,
  inviteEmailTemplate,
  resetPasswordEmailTemplate,
  invoiceApprovedEmailTemplate,
  invoiceUpdatedEmailTemplate,
  airFreightMilestoneEmailTemplate,
  airFreightExceptionEmailTemplate,
};
