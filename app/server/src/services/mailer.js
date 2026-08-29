// Transactional email, through Brevo's HTTP API.
//
// The API rather than SMTP on purpose: one fetch, no connection pool to keep
// warm, no port 587 to get blocked by a host, and a JSON error body that says
// what was wrong instead of a numeric SMTP code. Nothing here retries — a
// passcode that did not arrive in ten seconds is better re-requested by the
// person waiting for it than re-sent blind by a background task.

import { BREVO, MAIL_CONFIGURED, NODE_ENV } from '../config.js';

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export const configured = () => MAIL_CONFIGURED;

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Sends one message. Resolves `{ ok, messageId }` or `{ ok: false, reason }` —
 * it never throws, because every caller is on a path where a failed email must
 * not become a failed request. Callers decide what to tell the person.
 */
export async function send({ to, toName = null, subject, html, text, tags = [] }) {
  if (!MAIL_CONFIGURED) {
    if (NODE_ENV !== 'production') {
      console.warn(`\n  ✉  [mail disabled] would have sent to ${to}: ${subject}\n${text}\n`);
      return { ok: false, reason: 'not-configured', simulated: true };
    }
    return { ok: false, reason: 'not-configured' };
  }

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': BREVO.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: BREVO.senderName, email: BREVO.senderEmail },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        ...(BREVO.replyTo ? { replyTo: { email: BREVO.replyTo } } : {}),
        subject,
        htmlContent: html,
        textContent: text,
        ...(tags.length ? { tags } : {}),
      }),
      signal: AbortSignal.timeout(BREVO.timeoutMs),
    });
  } catch (err) {
    console.error('[mail] Brevo unreachable:', err.message);
    return { ok: false, reason: 'unreachable' };
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`[mail] Brevo refused the send (${res.status}): ${body.message ?? body.code ?? 'no detail'}`);
    return { ok: false, reason: body.code || `http-${res.status}`, detail: body.message ?? null };
  }

  const body = await res.json().catch(() => ({}));
  return { ok: true, messageId: body.messageId ?? null };
}

// ── Templates ───────────────────────────────────────────────────────────────
// Inline styles only. Every mail client that matters strips <style> blocks, and
// half of them strip class attributes too.

const shell = (heading, bodyHtml) => `
<div style="margin:0;padding:24px;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px;border:1px solid #e5e5ea">
    <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8a8a92;font-weight:600">GCloud</div>
    <h1 style="margin:14px 0 18px;font-size:21px;line-height:1.3;color:#111114;font-weight:650">${heading}</h1>
    ${bodyHtml}
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.6;color:#8a8a92;text-align:center">
    Sent by GCloud because somebody asked for it with this address. If that was not you, nothing has happened to your account yet — tell an administrator.
  </p>
</div>`;

const codeBlock = (code) => `
  <div style="margin:22px 0;padding:18px;background:#f4f4f6;border-radius:10px;text-align:center">
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:33px;letter-spacing:.34em;font-weight:650;color:#111114;padding-left:.34em">${escape(code)}</div>
  </div>`;

const note = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3a3a42">${t}</p>`;

export function dailyPasscodeMail({ name, code, ttlMinutes, expiresOn }) {
  return {
    subject: `${code} is your GCloud passcode for today`,
    text: `Hello ${name},\n\nYour GCloud passcode for today is ${code}.\n\n`
      + `It expires in ${ttlMinutes} minutes. Once accepted, this device stays signed in until midnight ${expiresOn}, `
      + 'and no further passcode is needed today.\n\n'
      + 'If you did not try to sign in, do not enter this code. Change your password and tell an administrator.\n',
    html: shell('Your passcode for today', [
      note(`Hello ${escape(name)}, here is the passcode for today's first sign-in.`),
      codeBlock(code),
      note(`It expires in <strong>${ttlMinutes} minutes</strong>. Once accepted, this device stays signed in until midnight (${escape(expiresOn)}) — you will not be asked again today.`),
      note('<strong>If you did not try to sign in</strong>, do not enter this code. Change your password and tell an administrator.'),
    ].join('')),
  };
}

export function passwordResetMail({ name, code, ttlMinutes }) {
  return {
    subject: `${code} is your GCloud password reset code`,
    text: `Hello ${name},\n\nUse ${code} to set a new GCloud password.\n\n`
      + `It expires in ${ttlMinutes} minutes and works once.\n\n`
      + 'If you did not ask to reset your password, ignore this — nothing has changed.\n',
    html: shell('Set a new password', [
      note(`Hello ${escape(name)}, use this code to set a new password.`),
      codeBlock(code),
      note(`It expires in <strong>${ttlMinutes} minutes</strong> and works once.`),
      note('If you did not ask for this, ignore it — nothing on your account has changed.'),
    ].join('')),
  };
}

export function newDeviceMail({ name, when, ip, userAgent }) {
  return {
    subject: 'A new device signed in to GCloud',
    text: `Hello ${name},\n\nA device that has not signed in before was used on your GCloud account.\n\n`
      + `When: ${when}\nAddress: ${ip}\nBrowser: ${userAgent}\n\n`
      + 'If this was you, nothing to do. If it was not, change your password now and tell an administrator.\n',
    html: shell('A new device signed in', [
      note(`Hello ${escape(name)}, a device that has not been seen on your account before just signed in.`),
      `<table style="margin:18px 0;font-size:14px;color:#3a3a42;border-collapse:collapse">
        <tr><td style="padding:4px 16px 4px 0;color:#8a8a92">When</td><td style="padding:4px 0">${escape(when)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#8a8a92">Address</td><td style="padding:4px 0">${escape(ip)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#8a8a92">Browser</td><td style="padding:4px 0">${escape(userAgent)}</td></tr>
      </table>`,
      note('If this was you, there is nothing to do. If it was not, <strong>change your password now</strong> and tell an administrator.'),
    ].join('')),
  };
}
