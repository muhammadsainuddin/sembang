import nodemailer from 'nodemailer';

export function verificationMailer(config) {
  let transport;
  return {
    async send({ email, code }) {
      transport ??= nodemailer.createTransport({
        ...config.smtp, pool: true, maxConnections: 2, maxMessages: 100, requireTLS: !config.smtp.secure,
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
        disableFileAccess: true, disableUrlAccess: true,
      });
      await transport.sendMail({ from: config.smtp.from, to: email, subject: 'Kod pengesahan Sembang',
        text: `Kod pengesahan Sembang kamu: ${code}\n\nKod ini tamat dalam 10 minit. Jangan kongsi kod ini. Jika kamu tidak membuat permintaan ini, abaikan emel ini.`,
      });
    },
    close() { transport?.close(); },
  };
}
