
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
  return { value: text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') };
}

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

export function fields(body, rules) {
  const value = {};
  for (const [key, rule] of Object.entries(rules)) {
    const out = rule(body?.[key], key);
    if (out.problem) return { ok: false, problem: out.problem };
    if (out.value !== null || key in (body ?? {})) value[key] = out.value;
  }
  return { ok: true, value };
}