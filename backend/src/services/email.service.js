// services/email.service.js
// Single Nodemailer service: account emails (verification / password reset) and ticket delivery.

const nodemailer = require('nodemailer');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class EmailService {
  constructor() {
    this.disabled = (process.env.MAIL_DISABLED || '').toLowerCase() === 'true';
    this.transporter = null;
    this.initTransporter();
  }

  initTransporter() {
    if (this.disabled) {
      console.log('ℹ️ MAIL_DISABLED=true — emails will run in simulation mode');
      return;
    }

    const host = process.env.SMTP_HOST || process.env.MAIL_HOST;
    const user = process.env.SMTP_USER || process.env.MAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.MAIL_PASS;
    const port = Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
    const secure = (process.env.SMTP_SECURE || process.env.MAIL_SECURE || 'false').toLowerCase() === 'true' || port === 465;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
      console.log('✉️ Email transporter initialized (SMTP)');
    } else {
      console.log('ℹ️ SMTP/MAIL credentials missing — emails will run in simulation mode');
    }
  }

  fromAddress() {
    return process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.MAIL_USER || 'no-reply@eventbooking.com';
  }

  /**
   * Account emails must actually be delivered (the user cannot continue without the OTP),
   * so a missing SMTP config is an error unless MAIL_DISABLED=true.
   */
  async sendAccountEmail({ to, subject, text, html }) {
    if (this.disabled) {
      console.log(`📱 [Email Simulation] "${subject}" to ${to}`);
      return;
    }
    if (!this.transporter) {
      throw new Error('Mail config missing (MAIL_HOST / MAIL_USER / MAIL_PASS)');
    }
    await this.transporter.sendMail({ from: this.fromAddress(), to, subject, text, html });
  }

  async sendVerificationEmail({ to, name, otp, baseUrl }) {
    if (!to || !otp || !baseUrl) {
      throw new Error('Missing email params');
    }

    const safeName = escapeHtml(name || 'User');
    const link = `${baseUrl.replace(/\/+$/, '')}/api/auth/verify-otp?email=${encodeURIComponent(
      to
    )}&otp=${encodeURIComponent(otp)}`;

    await this.sendAccountEmail({
      to,
      subject: 'Verify your email (OTP)',
      text:
        `Hi ${name || 'User'},\n\n` +
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
        `<p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">Verify it</a></p>` +
        `<p>If the button doesn't work, copy and paste this link into your browser:</p>` +
        `<p>${link}</p>` +
        `<p>If you did not create this account, you can ignore this email.</p>` +
        `</div>`,
    });
  }

  async sendPasswordResetEmail({ to, name, otp }) {
    if (!to || !otp) {
      throw new Error('Missing email params');
    }

    const minutes = Number(process.env.EMAIL_OTP_TTL_MINUTES || 10);
    await this.sendAccountEmail({
      to,
      subject: 'Reset your password (OTP)',
      text:
        `Hi ${name || 'User'},\n\n` +
        `Your password reset OTP is: ${otp}\n` +
        `It expires in ${minutes} minutes.\n\n` +
        `If you did not request a password reset, you can ignore this email.\n`,
      html:
        `<div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">` +
        `<p>Hi ${escapeHtml(name || 'User')},</p>` +
        `<p>Your password reset OTP is:</p>` +
        `<p style="font-size:18px;font-weight:bold;letter-spacing:2px;">${otp}</p>` +
        `<p>It expires in ${minutes} minutes.</p>` +
        `<p>If you did not request a password reset, you can ignore this email.</p>` +
        `</div>`,
    });
  }

  /**
   * Send confirmation ticket email (best effort: a failed send never fails the booking).
   */
  async sendTicketEmail({ to, ticketId, eventTitle, date, venue, seats, amount }) {
    if (!to) return;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; background: #0f172a; color: #ffffff; padding: 30px; border-radius: 16px; max-width: 540px; margin: 0 auto;">
        <div style="text-align: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 20px; margin-bottom: 20px;">
          <h2 style="color: #f84464; margin: 0;">🎟️ BOOKING CONFIRMED</h2>
          <p style="color: rgba(255,255,255,0.6); font-size: 13px; margin-top: 4px;">Ticket ID: ${escapeHtml(ticketId)}</p>
        </div>

        <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px; margin-bottom: 20px;">
          <h3 style="margin: 0 0 10px; color: #ffffff; font-size: 20px;">${escapeHtml(eventTitle)}</h3>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Date & Time:</strong> ${escapeHtml(date)}</p>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Venue:</strong> ${escapeHtml(venue)}</p>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Seats:</strong> ${escapeHtml(seats)}</p>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Amount Paid:</strong> ${escapeHtml(amount)}</p>
        </div>

        <div style="text-align: center; color: rgba(255,255,255,0.5); font-size: 12px;">
          <p>Present this ticket at the venue gate for entry.</p>
        </div>
      </div>
    `;

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: `"Event Booking" <${this.fromAddress()}>`,
          to,
          subject: `🎟️ Your Ticket for ${eventTitle} (ID: ${ticketId})`,
          html: htmlContent,
        });
        console.log(`✅ Ticket email sent successfully to ${to}`);
      } catch (err) {
        console.error('❌ Error sending ticket email:', err.message);
      }
    } else {
      console.log(`📱 [Email Simulation] Ticket ${ticketId} sent to ${to} (${eventTitle})`);
    }
  }
}

module.exports = new EmailService();
