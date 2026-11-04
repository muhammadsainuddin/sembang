import nodemailer from 'nodemailer';

export function verificationMailer(config) {
  let transport;
  return {
    async send({ email, code, purpose = 'verify' }) {
      transport ??= nodemailer.createTransport({
        ...config.smtp, pool: true, maxConnections: 2, maxMessages: 100, requireTLS: !config.smtp.secure,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        disableFileAccess: true, disableUrlAccess: true,
      });
      const reset = purpose === 'reset';
      await transport.sendMail({ from: config.smtp.from, to: email, subject: reset ? 'Your Zbuddy password reset code' : 'Your Zbuddy verification code',
        text: reset
          ? `Your Zbuddy password reset code: ${code}\n\nThis code expires in 10 minutes. Resetting removes the old encrypted chat history because the encryption key cannot be opened without the old password. Do not share this code. If you did not request it, ignore this email.`
          : `Your Zbuddy verification code: ${code}\n\nThis code expires in 10 minutes. Do not share it. If you did not request it, ignore this email.`,
      });
    },
    close() { transport?.close(); },
  };
}
