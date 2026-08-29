// Keeping a free-tier host awake.
//
// Render's free plan spins a service down after ~15 minutes with no inbound
// HTTP traffic, and the next visitor waits 30–60 seconds for a cold start. This
// sends the service a request of its own on an interval so that idle window
// never elapses.
//
// ── The limitation, stated plainly ──────────────────────────────────────────
// This can keep a service awake. It CANNOT wake one that has already slept,
// because when the host suspends the process it suspends this timer with it.
// A self-ping is therefore a good first line and a bad only line: if the
// service ever does go down — a deploy, a crash loop, an outage — nothing here
// brings it back.
//
// The complete answer is an *external* pinger as well, which reaches the
// service from outside and can wake it cold. `.github/workflows/keepalive.yml`
// does that on a schedule. Run both: this one is immediate and free of any
// third party, the external one survives the service being asleep.
//
// ── The cost, also stated plainly ───────────────────────────────────────────
// Render's free tier includes 750 instance-hours per month. A month is about
// 730 hours, so a service kept awake around the clock consumes essentially the
// whole allowance. That is fine for one service and will not stretch to two.

import { KEEPALIVE, NODE_ENV } from '../config.js';

const state = {
  enabled: false,
  url: null,
  intervalMin: 0,
  startedAt: null,
  lastPingAt: null,
  lastStatus: null,
  lastDurationMs: null,
  successes: 0,
  failures: 0,
  consecutiveFailures: 0,
};

export const status = () => ({ ...state });

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i;

async function ping() {
  const started = Date.now();
  try {
    const res = await fetch(state.url, {
      method: 'GET',
      headers: { 'user-agent': 'gcloud-keepalive/1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(KEEPALIVE.timeoutMs),
    });
    state.lastDurationMs = Date.now() - started;
    state.lastPingAt = new Date().toISOString();
    state.lastStatus = res.status;

    // Any answer at all proves the service is awake and serving, which is the
    // only thing this is measuring. A 503 from a degraded-but-running task
    // still resets the host's idle timer.
    if (res.status >= 200 && res.status < 500) {
      state.successes += 1;
      state.consecutiveFailures = 0;
    } else {
      state.failures += 1;
      state.consecutiveFailures += 1;
      console.warn(`[keepalive] ${state.url} answered ${res.status}`);
    }
  } catch (err) {
    state.lastDurationMs = Date.now() - started;
    state.lastPingAt = new Date().toISOString();
    state.lastStatus = null;
    state.failures += 1;
    state.consecutiveFailures += 1;

    // Log the first failure and then only every sixth, because a free tier
    // also caps log volume and a genuinely unreachable URL would otherwise
    // fill it with the same line for hours.
    if (state.consecutiveFailures === 1 || state.consecutiveFailures % 6 === 0) {
      console.warn(`[keepalive] ${state.url} unreachable (${state.consecutiveFailures}x): ${err.message}`);
    }
  }
}

/**
 * Starts the pinger. Returns a stop function; safe to call when disabled.
 *
 * Refuses to run against a loopback address unless forced: pinging yourself on
 * localhost keeps nothing awake and just burns a request every ten minutes.
 */
export function start() {
  if (!KEEPALIVE.enabled) return () => {};

  const url = KEEPALIVE.url;
  if (!url) {
    console.warn('[keepalive] enabled but no URL could be determined — set KEEPALIVE_URL.');
    return () => {};
  }
  if (LOCAL.test(url) && !KEEPALIVE.allowLocal) {
    console.warn(`[keepalive] ${url} is a loopback address, which keeps nothing awake. Not starting.`);
    return () => {};
  }

  state.enabled = true;
  state.url = url;
  state.intervalMin = KEEPALIVE.intervalMin;
  state.startedAt = new Date().toISOString();

  const period = KEEPALIVE.intervalMin * 60_000;

  // A little jitter so that several instances, or a restart loop, do not all
  // fire on the same second.
  const jitter = Math.floor(Math.random() * 20_000);

  const first = setTimeout(() => { void ping(); }, 30_000 + jitter);
  const timer = setInterval(() => { void ping(); }, period);
  timer.unref?.();
  first.unref?.();

  if (NODE_ENV !== 'test') {
    console.log(`  Keep-alive   every ${KEEPALIVE.intervalMin} min → ${url}`);
  }

  return () => { clearTimeout(first); clearInterval(timer); state.enabled = false; };
}
