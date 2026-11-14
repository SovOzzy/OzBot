// Word-level Markov chain. States are the last `order` words; END marks the end of a message.
// Pure (no Discord / DB) so it can be tested on its own.
const SEP = '\u0001';
export const END = '\u0000';

export function cleanMessage(text, { stripLinks = true, stripMentions = true } = {}) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');                 // code blocks
  if (stripLinks) s = s.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  if (stripMentions) s = s.replace(/<@[!&]?\d+>|<#\d+>|@everyone|@here/g, ' ');
  s = s.replace(/<a?:(\w+):\d+>/g, ' ');                  // custom emoji
  s = s.replace(/<t:\d+(:\w)?>/g, ' ');                   // timestamps
  s = s.replace(/^\s*>+ ?/gm, ' ').replace(/[*_~`|]+/g, ' '); // quotes + markdown
  return s.replace(/\s+/g, ' ').trim();
}

export class Chain {
  constructor(order = 2) {
    this.order = order;
    this.next = new Map();   // state -> Map(word -> count)
    this.starts = [];        // starting states (one per message, duplicates = weight)
    this.seen = new Set();   // normalised source messages, to avoid parroting one verbatim
    this.size = 0;
  }

  static norm(s) { return s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim(); }

  add(text) {
    const words = text.split(' ').filter(Boolean);
    if (words.length < 2) return false;
    this.size++;
    this.seen.add(Chain.norm(text));
    const n = Math.min(this.order, words.length);
    this.starts.push(words.slice(0, n).join(SEP));
    for (let i = 0; i + n <= words.length; i++) {
      const state = words.slice(i, i + n).join(SEP);
      const word = words[i + n] ?? END;
      let m = this.next.get(state);
      if (!m) { m = new Map(); this.next.set(state, m); }
      m.set(word, (m.get(word) ?? 0) + 1);
    }
    return true;
  }

  #pick(m, rand) {
    let total = 0;
    for (const c of m.values()) total += c;
    let r = rand() * total;
    for (const [w, c] of m) { r -= c; if (r < 0) return w; }
    return END;
  }

  // One attempt: walk from a random start (or one containing `about`) until END or maxWords.
  #walk({ maxWords, about, rand }) {
    let start;
    if (about) {
      const want = about.toLowerCase();
      const matches = this.starts.filter((s) => s.toLowerCase().split(SEP).includes(want));
      const mid = matches.length ? null : [...this.next.keys()].filter((s) => s.toLowerCase().split(SEP).includes(want));
      const pool = matches.length ? matches : mid;
      if (!pool?.length) return null;
      start = pool[Math.floor(rand() * pool.length)];
    } else {
      start = this.starts[Math.floor(rand() * this.starts.length)];
    }
    const words = start.split(SEP);
    while (words.length < maxWords) {
      const state = words.slice(-this.order).join(SEP);
      const m = this.next.get(state) ?? this.next.get(words.slice(-Math.min(this.order, words.length)).join(SEP));
      if (!m) break;
      const w = this.#pick(m, rand);
      if (w === END) break;
      words.push(w);
    }
    return words;
  }

  generate({ minWords = 4, maxWords = 25, about = '', allowCopy = false, tries = 40, rand = Math.random } = {}) {
    if (!this.starts.length) return null;
    let fallback = null;
    for (let i = 0; i < tries; i++) {
      const words = this.#walk({ maxWords, about: about.trim(), rand });
      if (!words) return null;
      const text = words.join(' ');
      const copy = this.seen.has(Chain.norm(text));
      if (words.length >= minWords && (allowCopy || !copy)) return text;
      if (!copy && (!fallback || words.length > fallback.split(' ').length)) fallback = text;
    }
    return fallback;
  }

  stats() { return { messages: this.size, states: this.next.size, order: this.order }; }
}
