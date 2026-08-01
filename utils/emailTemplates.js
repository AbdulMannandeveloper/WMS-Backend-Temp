const otpEmailTemplate = ({ otp, expiresMinutes }) => {
  const subject = 'Your ProPackers UK verification code';
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
  const subject = 'Set Your ProPackers UK Account Password';
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
  const subject = 'Reset Your ProPackers UK Password';
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
  const subject = `Your ProPackers UK Invoice for ${billingMonth} is Ready`;
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

module.exports = {
  otpEmailTemplate,
  inviteEmailTemplate,
  resetPasswordEmailTemplate,
  invoiceApprovedEmailTemplate,
};
