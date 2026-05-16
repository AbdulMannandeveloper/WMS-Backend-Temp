const otpEmailTemplate = ({ otp, expiresMinutes }) => {
  const subject = 'Your ProPackers verification code';
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
  const subject = 'Set Your ProPackers Account Password';
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

module.exports = {
  otpEmailTemplate,
  inviteEmailTemplate,
};
