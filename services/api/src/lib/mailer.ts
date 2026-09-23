import nodemailer from 'nodemailer';
import { env } from '../env.js';
import { logger } from '../logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    })
  : null;


export async function sendMail(mail: Mail): Promise<void> {
  if (!transport) {
    logger.info({ to: mail.to, subject: mail.subject, body: mail.text }, 'Email (no SMTP configured, logged only)');
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, ...mail });
  } catch (err) {
    logger.error({ err, to: mail.to }, 'Failed to send email');
  }
}
