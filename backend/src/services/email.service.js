// services/email.service.js
// Nodemailer Ticket Delivery Service

const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.transporter = null;
    this.initTransporter();
  }

  initTransporter() {
    const disabled = (process.env.MAIL_DISABLED || '').toLowerCase() === 'true';
    if (disabled) {
      console.log('ℹ️ MAIL_DISABLED=true — Ticket emails will run in simulation mode');
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
      console.log('ℹ️ SMTP/MAIL credentials missing — Ticket emails will run in simulation mode');
    }
  }

  /**
   * Send confirmation ticket email
   */
  async sendTicketEmail({ to, ticketId, eventTitle, date, venue, seats, amount }) {
    if (!to) return;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; background: #0f172a; color: #ffffff; padding: 30px; border-radius: 16px; max-width: 540px; margin: 0 auto;">
        <div style="text-align: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 20px; margin-bottom: 20px;">
          <h2 style="color: #f84464; margin: 0;">🎟️ BOOKING CONFIRMED</h2>
          <p style="color: rgba(255,255,255,0.6); font-size: 13px; margin-top: 4px;">Ticket ID: ${ticketId}</p>
        </div>

        <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 12px; margin-bottom: 20px;">
          <h3 style="margin: 0 0 10px; color: #ffffff; font-size: 20px;">${eventTitle}</h3>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Date & Time:</strong> ${date}</p>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Venue:</strong> ${venue}</p>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Seats:</strong> ${seats}</p>
          <p style="margin: 4px 0; color: rgba(255,255,255,0.7); font-size: 14px;"><strong>Amount Paid:</strong> ${amount}</p>
        </div>

        <div style="text-align: center; color: rgba(255,255,255,0.5); font-size: 12px;">
          <p>Present this ticket at the venue gate for entry.</p>
        </div>
      </div>
    `;

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: `"Event Booking" <${process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.MAIL_USER || 'no-reply@eventbooking.com'}>`,
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
