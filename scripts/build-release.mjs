#!/usr/bin/env node
/**
 * 纯 Node 构建纯净发布包：将 ./plugin/ 打包为 dist/note-offload-v<version>.zip 与 .sha256。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectFiles(dir, baseDir, out) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.name === 'node_modules' || ent.name === '__pycache__' || ent.name === '.DS_Store') {
      continue;
    }
    if (ent.isDirectory()) {
      collectFiles(full, baseDir, out);
    } else if (ent.isFile()) {
      const rel = relative(baseDir, full).replace(/\\/g, '/');
      const st = statSync(full);
      out.push({
        relPath: rel,
        data: readFileSync(full),
        mode: st.mode & 0o777,
      });
    }
  }
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  let rawBytes = 0;

  for (const item of entries) {
    const filename = Buffer.from(item.relPath, 'utf-8');
    const data = item.data;
    rawBytes += data.length;
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const unixMode = (0o100000 | (item.mode & 0o111 ? 0o755 : 0o644)) >>> 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x5421, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    header.writeUInt16LE(0, 28);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x5421, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE((unixMode << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);

    locals.push(header, filename, payload);
    central.push(entry, filename);
    offset += header.length + filename.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return {
    buffer: Buffer.concat([...locals, directory, end]),
    rawBytes,
  };
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const version = pkg.version;
  const pluginDir = join(ROOT, 'plugin');
  const outDir = resolve(process.argv[2] || join(ROOT, 'dist'));

  const files = [];
  collectFiles(pluginDir, pluginDir, files);
  const { buffer: zipBuf, rawBytes } = buildZip(files);
  const sha = createHash('sha256').update(zipBuf).digest('hex');

  const zipName = `note-offload-v${version}.zip`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, zipName), zipBuf);
  writeFileSync(join(outDir, `${zipName}.sha256`), `${sha}  ${zipName}\n`, 'utf-8');

  process.stdout.write(JSON.stringify({
    version,
    files: files.length,
    rawBytes,
    zipBytes: zipBuf.length,
    zip: zipName,
    sha256: sha,
  }) + '\n');
}

main();
