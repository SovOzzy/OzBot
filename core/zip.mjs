// Minimal ZIP writer (stored, no compression: WAV audio barely compresses anyway). No dependencies.
// writeZip(out, [{ name: 'dataset/wavs/a.wav', path: '/abs/a.wav' } | { name, data: Buffer|string }])
import { open, readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

export async function writeZip(outPath, entries) {
  const fh = await open(outPath, 'w');
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  try {
    for (const e of entries) {
      const data = e.data != null ? Buffer.from(e.data) : await readFile(e.path);
      const name = Buffer.from(e.name, 'utf8');
      const crc = crc32(data) >>> 0;
      if (offset + data.length > 0xffffffff) throw new Error('ZIP too large (over 4 GB)');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      await fh.write(local); await fh.write(name); await fh.write(data);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(0, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([c, name]));
      offset += 30 + name.length + data.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    await fh.write(cd); await fh.write(end);
  } finally { await fh.close(); }
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
