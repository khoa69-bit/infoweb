import dns from 'node:dns/promises';
import net from 'node:net';

// Email addresses that are obviously invalid / placeholder
const DUMMY_PREFIXES = ['example', 'test', 'demo', 'noreply', 'no-reply', 'donotreply', 'do-not-reply'];

// Common role-based priority prefixes (prefer these over generic ones)
const PRIORITY_PREFIXES = ['sales', 'export', 'info', 'contact', 'marketing', 'inquiry', 'trade', 'international'];

/**
 * Step 1: Validate email format with regex.
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();

  // Check dummy prefixes
  const localPart = trimmed.split('@')[0];
  if (DUMMY_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '.'))) {
    return false;
  }

  // Standard email regex
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(trimmed);
}

/**
 * Step 2: Check if the email's domain has MX records (fast DNS lookup).
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function hasMXRecord(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1];
  if (!domain) return false;

  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

/**
 * Step 3 (Optional): SMTP handshake verify — connect to mail server and check if
 * the address exists without actually sending an email.
 *
 * WARNING: Many servers refuse VRFY or return 252 for privacy.
 * Many ISPs block outbound port 25. Use only as optional enhancement.
 *
 * @param {string} email
 * @param {number} timeoutMs
 * @returns {Promise<'DELIVERABLE' | 'UNVERIFIABLE' | 'REJECTED'>}
 */
export async function smtpVerify(email, timeoutMs = 5000) {
  const domain = email.split('@')[1];
  if (!domain) return 'UNVERIFIABLE';

  let mxHost = null;
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0) return 'UNVERIFIABLE';
    mxHost = records.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch {
    return 'UNVERIFIABLE';
  }

  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve('UNVERIFIABLE');
    }, timeoutMs);

    const socket = net.createConnection(25, mxHost);
    let stage = 0;
    let buffer = '';

    socket.setTimeout(timeoutMs);
    socket.setEncoding('ascii');

    socket.on('data', (data) => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const code = parseInt(line.substring(0, 3), 10);
        if (stage === 0 && code === 220) {
          socket.write(`EHLO verify.local\r\n`);
          stage = 1;
        } else if (stage === 1 && (code === 250 || code === 220)) {
          socket.write(`MAIL FROM:<verify@verify.local>\r\n`);
          stage = 2;
        } else if (stage === 2 && code === 250) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          stage = 3;
        } else if (stage === 3) {
          clearTimeout(timeout);
          socket.write('QUIT\r\n');
          socket.destroy();
          if (code === 250 || code === 251) {
            resolve('DELIVERABLE');
          } else if (code >= 550 && code < 560) {
            resolve('REJECTED');
          } else {
            resolve('UNVERIFIABLE');
          }
          return;
        } else if (code >= 400) {
          clearTimeout(timeout);
          socket.destroy();
          resolve('UNVERIFIABLE');
          return;
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve('UNVERIFIABLE');
    });

    socket.on('timeout', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve('UNVERIFIABLE');
    });
  });
}

/**
 * Full email validation pipeline:
 * 1. Format check
 * 2. DNS MX check
 * 3. (Optional) SMTP verify
 *
 * @param {string} email
 * @param {object} options - { smtpCheck?: boolean }
 * @returns {Promise<{ email: string, status: 'DELIVERABLE'|'MX_OK'|'MX_FAIL'|'INVALID_FORMAT'|'UNVERIFIABLE' }>}
 */
export async function validateEmail(email, options = {}) {
  const trimmed = (email || '').trim().toLowerCase();

  if (!isValidEmailFormat(trimmed)) {
    return { email: trimmed, status: 'INVALID_FORMAT' };
  }

  const mxOk = await hasMXRecord(trimmed);
  if (!mxOk) {
    return { email: trimmed, status: 'MX_FAIL' };
  }

  if (options.smtpCheck) {
    const smtpResult = await smtpVerify(trimmed);
    return { email: trimmed, status: smtpResult };
  }

  return { email: trimmed, status: 'MX_OK' };
}

/**
 * Filter and prioritize a list of emails:
 * 1. Remove invalid format / dummy addresses
 * 2. Sort: priority role prefixes first (sales@, export@, info@...)
 * 3. Return top N
 *
 * @param {string[]} emails
 * @param {number} topN
 * @returns {string[]}
 */
export function filterAndPrioritizeEmails(emails, topN = 3) {
  const valid = emails
    .map(e => e.trim().toLowerCase())
    .filter(e => isValidEmailFormat(e));

  const deduped = [...new Set(valid)];

  // Sort: priority prefixes first
  deduped.sort((a, b) => {
    const aLocal = a.split('@')[0];
    const bLocal = b.split('@')[0];
    const aPriority = PRIORITY_PREFIXES.findIndex(p => aLocal.startsWith(p));
    const bPriority = PRIORITY_PREFIXES.findIndex(p => bLocal.startsWith(p));

    const aScore = aPriority === -1 ? 999 : aPriority;
    const bScore = bPriority === -1 ? 999 : bPriority;
    return aScore - bScore;
  });

  return deduped.slice(0, topN);
}

/**
 * Batch validate a list of emails (DNS MX only by default).
 * @param {string[]} emails
 * @returns {Promise<{ email: string, status: string }[]>}
 */
export async function batchValidateEmails(emails) {
  const results = await Promise.all(
    emails.map(e => validateEmail(e, { smtpCheck: false }))
  );
  return results;
}
