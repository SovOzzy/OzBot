// Settings schema: modules describe their settings as a list of fields; the dashboard renders a form from it
// and the core coerces/validates whatever comes back before a module ever sees it.
//
// Field: { key, type, label, help?, default?, min?, max?, step?, options?: [{value,label}], maxLength? }
// Types: text, textarea, number, boolean, select, textChannel, textChannels, voiceChannel, voice

const SNOWFLAKE = /^\d{5,25}$/;

export function defaults(fields = []) {
  const out = {};
  for (const f of fields) out[f.key] = f.default ?? emptyFor(f.type);
  return out;
}

function emptyFor(type) {
  if (type === 'boolean') return false;
  if (type === 'number') return 0;
  if (type === 'textChannels') return [];
  return '';
}

export function coerce(fields = [], input = {}, current = {}) {
  const out = { ...defaults(fields), ...current };
  const errors = {};
  for (const f of fields) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    switch (f.type) {
      case 'boolean': out[f.key] = v === true || v === 'true' || v === 1; break;
      case 'number': {
        let n = Number(v);
        if (!Number.isFinite(n)) { errors[f.key] = 'Not a number'; break; }
        if (f.min != null && n < f.min) n = f.min;
        if (f.max != null && n > f.max) n = f.max;
        if (f.step != null && Number.isInteger(f.step)) n = Math.round(n);
        out[f.key] = n; break;
      }
      case 'select': {
        const ok = (f.options ?? []).some((o) => String(o.value) === String(v));
        if (!ok) { errors[f.key] = 'Not one of the options'; break; }
        out[f.key] = (f.options.find((o) => String(o.value) === String(v))).value; break;
      }
      case 'textChannel': case 'voiceChannel':
        if (v !== '' && v != null && !SNOWFLAKE.test(String(v))) { errors[f.key] = 'Bad channel id'; break; }
        out[f.key] = v ? String(v) : ''; break;
      case 'textChannels': {
        const arr = Array.isArray(v) ? v.map(String) : [];
        if (arr.some((x) => !SNOWFLAKE.test(x))) { errors[f.key] = 'Bad channel id'; break; }
        out[f.key] = [...new Set(arr)]; break;
      }
      case 'voice':
        if (v && !/^[A-Za-z0-9_.-]{1,120}$/.test(String(v))) { errors[f.key] = 'Bad voice name'; break; }
        out[f.key] = v ? String(v) : ''; break;
      default: { // text / textarea
        const s = String(v ?? '');
        const max = f.maxLength ?? (f.type === 'textarea' ? 4000 : 300);
        if (s.length > max) { errors[f.key] = `Longer than ${max} characters`; break; }
        out[f.key] = s;
      }
    }
  }
  return { values: out, errors };
}
