// MongoDB connection. One connection per process, opened before the first request and
// closed on shutdown (§3.3).
import mongoose from 'mongoose';
import { MONGODB_DB, MONGODB_URI, NODE_ENV } from '../config.js';

mongoose.set('strictQuery', false);

// A driver failure here arrives as a sixty-line TopologyDescription dump that says
// nothing about what to do. These are the three things it is almost always caused by.
//
// The per-server errors have to be included in the text being matched, and that is not a
// detail. Mongoose replaces the real cause with one generic sentence about IP allowlists
// on *every* server-selection failure, whatever went wrong; the actual reason — a TLS
// alert, a refused connection, a DNS failure — survives only inside
// `err.reason.servers`. Matching on the message alone meant every branch below was
// unreachable for exactly the class of failure it was written for.
function explain(err) {
  const perServer = [...(err?.reason?.servers?.values?.() ?? [])]
    .map((desc) => desc?.error?.message ?? '')
    .join(' ');
  const text = `${err?.name} ${err?.message} ${perServer}`;
  if (/SSL alert number 8|tlsv1 alert internal error/i.test(text)) {
    return 'Atlas accepted the TCP connection and then closed the TLS one. That is what it'
      + ' does when the connecting IP is not on the allowlist — it is not a password'
      + ' problem, and a wrong password would fail differently.\n'
      + '    Atlas → Network Access → IP Access List → Add current IP address.\n'
      + '    A home or office IP is reassigned by the ISP without warning, so this recurs.';
  }
  if (/Authentication failed|bad auth/i.test(text)) {
    return 'The username or password in MONGODB_URI was rejected. A password containing'
      + ' @ : / ? # or % must be percent-encoded in the URI.';
  }
  if (/ECONNREFUSED/i.test(text)) {
    return 'Nothing is listening at that address. If MongoDB is in Docker and this process'
      + ' is too, use the service name (mongodb://mongo:27017) — inside a container,'
      + ' 127.0.0.1 is the container.';
  }
  if (/querySrv|ENOTFOUND|EAI_AGAIN/i.test(text)) return 'The hostname in MONGODB_URI does not resolve.';
  return null;
}

export async function connect({ attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await mongoose.connect(MONGODB_URI, {
        dbName: MONGODB_DB,
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 20,
        retryWrites: true,
      });
      break;
    } catch (err) {
      // A restarting container or a laptop waking up deserves a couple of retries before
      // anyone is told anything is wrong.
      if (attempt < attempts) {
        console.warn(`[mongo] connection attempt ${attempt}/${attempts} failed, retrying…`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 2000 * attempt); });
        continue;
      }
      const hint = explain(err);
      const safeUri = MONGODB_URI.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@');
      const e = new Error(
        `Could not reach MongoDB at ${safeUri}\n`
        + `    ${err.name}: ${String(err.message).split('\n')[0]}\n`
        + (hint ? `\n  ${hint}\n` : ''),
      );
      e.cause = err;
      throw e;
    }
  }
  if (NODE_ENV !== 'production') {
    mongoose.connection.on('error', (err) => console.error('[mongo]', err.message));
  }
  return mongoose.connection;
}

export async function disconnect() {
  await mongoose.connection.close();
}

export const connectionInfo = () => ({
  host: mongoose.connection.host,
  db: mongoose.connection.name,
  readyState: mongoose.connection.readyState,
});

export { mongoose };
