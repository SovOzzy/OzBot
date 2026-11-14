// Small audio helpers shared by modules (ffmpeg).
import { spawn } from 'node:child_process';

// WAV -> MP3 (mono, 64 kbit/s: ~8 KB per second of speech). Discord plays MP3 attachments inline.
export function wavToMp3(wav, out) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', out],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffmpeg mp3 failed (${code}): ${err.trim().slice(0, 200)}`))));
  });
}

// "oz-2131.mp3" style attachment names
export function clipFileName(voiceName, at = new Date()) {
  const slug = String(voiceName || 'ozbot').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ozbot';
  return `${slug}-${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}.mp3`;
}
