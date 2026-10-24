const nodemailer = require('nodemailer');

function getTransporter() {
  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT || 587);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  const secure = (process.env.MAIL_SECURE || 'false').toLowerCase() === 'true';
  const disabled = (process.env.MAIL_DISABLED || '').toLowerCase() === 'true';

  if (disabled) {
    return {
      // mock transporter for local/dev
      async sendMail(payload) {
        console.log('MAIL_DISABLED=true, skipping email send.');
        console.log('MAIL_PAYLOAD:', {
          to: payload.to,
          subject: payload.subject,
        });
      },
    };
  }

  if (!host || !user || !pass) {
    throw new Error('Mail config missing (MAIL_HOST / MAIL_USER / MAIL_PASS)');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function buildVerificationEmail({ name, link, otp }) {
  const safeName = name || 'User';

  return {
    subject: 'Verify your email (OTP)',
    text:
      `Hi ${safeName},\n\n` +
      `Your OTP is: ${otp}\n\n` +
      `You can verify by clicking this link:\n` +
      `${link}\n\n` +
      `If you did not create this account, you can ignore this email.\n`,
    html:
      `<div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">` +
      `<p>Hi ${safeName},</p>` +
      `<p>Thanks for registering. Your OTP is:</p>` +
      `<p style="font-size:18px;font-weight:bold;letter-spacing:2px;">${otp}</p>` +
      `<p>You can also verify by clicking the button below:</p>` +
      `<p>` +
      `<a href="${link}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">` +
      `Verify it` +
      `</a>` +
      `</p>` +
      `<p>If the button doesn't work, copy and paste this link into your browser:</p>` +
      `<p>${link}</p>` +
      `<p>If you did not create this account, you can ignore this email.</p>` +
      `</div>`,
  };
}

async function sendVerificationEmail({ to, name, otp, baseUrl }) {
  if (!to || !otp || !baseUrl) {
    throw new Error('Missing email params');
  }

  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  const link = `${baseUrl.replace(/\/+$/, '')}/api/auth/verify-otp?email=${encodeURIComponent(
    to
  )}&otp=${encodeURIComponent(otp)}`;
  const transporter = getTransporter();
  const content = buildVerificationEmail({ name, link, otp });

  await transporter.sendMail({
    from,
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
}

module.exports = { sendVerificationEmail };
