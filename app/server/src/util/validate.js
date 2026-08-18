// Request-body validation (§12.7).
//
// The environment has been validated by a schema since the first commit; request bodies
// have not, and the asymmetry is backwards — the environment is written by the operator
// and the body is written by whoever is calling. Two concrete consequences of leaving it
// unvalidated, both of which this file closes:
//
//   Type confusion.  A field the code expects to be a string arrives as an object or an
//                    array, and the handler either throws a 500 with a stack behind it or
//                    stores a shape nothing else can read.
//   Unbounded size.  The 1 MB body cap is per request, not per document. A description
//                    field with no ceiling is 1 MB of catalogue per call, forever, and
//                    every search pass then reads it.
//
// Deliberately small and dependency-free: a handful of coercions that return a value or a
// problem string, rather than a schema language nobody else in the codebase is using.

export const LIMITS = {
  name: 255,
  description: 4000,
  note: 1000,
  tag: 60,
  tags: 50,
  email: 254,
  query: 200,
  ids: 200,
};

/** A trimmed string, or null when absent. Rejects anything that is not a primitive. */
export function str(value, { max = 255, field = 'value', required = false, allowEmpty = false } = {}) {
  if (value == null) {
    return required ? { problem: `${field} is required.` } : { value: null };
  }
  if (typeof value === 'object') return { problem: `${field} must be text.` };
  const text = String(value).trim();
  if (!text && !allowEmpty) {
    return required ? { problem: `${field} is required.` } : { value: '' };
  }
  if (text.length > max) return { problem: `${field} is limited to ${max} characters.` };
  // Control characters in stored text end up in filenames, headers and CSV exports.
  // eslint-disable-next-line no-control-regex
  return { value: text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') };
}

/** An array of short strings — tags, ids, email addresses. */
export function list(value, { max = 50, itemMax = 60, field = 'value' } = {}) {
  if (value == null) return { value: null };
  if (!Array.isArray(value)) return { problem: `${field} must be a list.` };
  if (value.length > max) return { problem: `${field} is limited to ${max} entries.` };
  const out = [];
  for (const item of value) {
    if (typeof item === 'object') return { problem: `${field} must be a list of text values.` };
    const text = String(item).trim();
    if (!text) continue;
    if (text.length > itemMax) return { problem: `Each entry in ${field} is limited to ${itemMax} characters.` };
    out.push(text);
  }
  return { value: [...new Set(out)] };
}

/** One of a fixed set, or a stated fallback. */
export function oneOf(value, allowed, { field = 'value', fallback = null, required = false } = {}) {
  if (value == null || value === '') {
    return required ? { problem: `${field} is required.` } : { value: fallback };
  }
  if (!allowed.includes(value)) {
    return { problem: `${field} must be one of: ${allowed.join(', ')}.` };
  }
  return { value };
}

export function int(value, { min = 0, max = Number.MAX_SAFE_INTEGER, field = 'value', fallback = null } = {}) {
  if (value == null || value === '') return { value: fallback };
  const n = Number(value);
  if (!Number.isFinite(n)) return { problem: `${field} must be a number.` };
  if (n < min || n > max) return { problem: `${field} must be between ${min} and ${max}.` };
  return { value: Math.floor(n) };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function email(value, { field = 'email', required = false } = {}) {
  const out = str(value, { max: LIMITS.email, field, required });
  if (out.problem) return out;
  if (!out.value) return out;
  const address = out.value.toLowerCase();
  if (!EMAIL.test(address)) return { problem: `${field} does not look like an email address.` };
  return { value: address };
}

/**
 * Runs a set of field rules over a body and collects the first problem.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, problem }`, so a route reads:
 *
 *   const check = fields(req.body, { name: (v) => str(v, { required: true }) });
 *   if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
 */
export function fields(body, rules) {
  const value = {};
  for (const [key, rule] of Object.entries(rules)) {
    const out = rule(body?.[key], key);
    if (out.problem) return { ok: false, problem: out.problem };
    if (out.value !== null || key in (body ?? {})) value[key] = out.value;
  }
  return { ok: true, value };
}
