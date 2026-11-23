import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isLockStale(lockPath, staleMs) {
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    // 锁文件刚被持锁者释放，可直接重新尝试获取
    if (err?.code === 'ENOENT') return true;
  }
  if (raw) {
    try {
      const info = JSON.parse(raw);
      if (Number.isInteger(info?.pid) && !isPidAlive(info.pid)) {
        return true;
      }
      if (typeof info?.ts === 'number' && Date.now() - info.ts > staleMs) {
        return true;
      }
    } catch {
      // 内容损坏则回退到文件 mtime 判定
    }
  }
  try {
    const st = statSync(lockPath);
    return Date.now() - st.mtimeMs > staleMs;
  } catch (err) {
    return err?.code === 'ENOENT';
  }
}

/**
 * 原子写入文件：先写同目录临时文件再 rename 覆盖，避免并发读写或中途崩溃留下半截文件。
 * @param {string} targetPath
 * @param {string | Uint8Array} content
 */
export function atomicWriteSync(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, content, typeof content === 'string' ? 'utf-8' : undefined);
    renameSync(tmpPath, targetPath);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 忽略清理临时文件失败
      }
    }
  }
}

/**
 * 基于排他锁文件的同步跨进程互斥执行，支持死进程残留自动回收、token 归属校验释放、超时告警与严格模式。
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number, strict?: boolean, onTimeout?: (info: { lockPath: string, timeoutMs: number, staleMs: number, strict: boolean, reason: string }) => void }} [options]
 * @returns {T}
 */
export function withFileLockSync(
  lockPath,
  fn,
  { timeoutMs = 5000, staleMs = 15000, strict = false, onTimeout = null } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let failReason = '';

  while (true) {
    let fd = -1;
    try {
      fd = openSync(lockPath, 'wx');
      const payload = JSON.stringify({ pid: process.pid, token, ts: Date.now() });
      writeFileSync(fd, payload, 'utf-8');
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        failReason = err?.code || 'OPEN_ERR';
        break;
      }
      if (isLockStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // 其他并发进程已抢先回收，继续竞争即可
        }
      }
      if (Date.now() >= deadline) {
        failReason = 'TIMEOUT';
        break;
      }
      sleepMs(8 + Math.floor(Math.random() * 10));
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          // 忽略关闭异常
        }
      }
    }
  }

  if (!acquired) {
    if (typeof onTimeout === 'function') {
      try {
        onTimeout({ lockPath, timeoutMs, staleMs, strict, reason: failReason || 'TIMEOUT' });
      } catch {
        // 忽略超时回调函数内部异常
      }
    }
    if (strict) {
      const err = new Error(`获取文件锁超时 (${timeoutMs}ms, reason=${failReason || 'TIMEOUT'})`);
      err.code = 'ELOCKTIMEOUT';
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        const raw = readFileSync(lockPath, 'utf-8');
        const info = JSON.parse(raw);
        if (info?.token === token) {
          unlinkSync(lockPath);
        }
      } catch {
        // 锁已不存在或已被合法回收
      }
    }
  }
}
