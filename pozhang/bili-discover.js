/**
 * 发现本机正在运行的 billion-context 代理（上下文压缩插件）。
 *
 * 为什么不用固定端口：bili 的端口分「用户区 8787」和「lane 派生区 18787+」，
 * 派生实例的端口每台设备、每个 lane 都不同，且被占用会自动跳。
 * 它自己会把当前实例写进状态目录，我们读那个即可：
 *   ~/.local/state/billion-context/proxy-origin      {origin,pid,port,lane}
 *   ~/.local/state/billion-context/port-zone.json    {lanes:{<lane>:port}}
 *
 * 校验：pid 存活 + /__bili/status 可达，避免读到过期登记。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

const HOME = homedir();
const STATE = join(HOME, '.local', 'state', 'billion-context');

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function probe(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__bili/status', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve({ ok: true, version: j.version, origin: j.origin });
        } catch {
          resolve({ ok: res.statusCode === 200 });
        }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

let cache = { at: 0, value: null };

/**
 * @returns {Promise<{port:number, lane?:string, version?:string, source:string}|null>}
 */
export async function discoverBili({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 10_000) return cache.value;

  const candidates = [];

  const origin = readJson(join(STATE, 'proxy-origin'));
  if (origin && origin.port && (origin.pid ? alive(origin.pid) : true)) {
    candidates.push({ port: Number(origin.port), lane: origin.lane, source: 'proxy-origin', pid: origin.pid });
  }

  const zones = readJson(join(STATE, 'port-zone.json'));
  if (zones && zones.lanes && typeof zones.lanes === 'object') {
    for (const [lane, port] of Object.entries(zones.lanes)) {
      if (Number(port) > 0) candidates.push({ port: Number(port), lane, source: 'port-zone' });
    }
  }

  // 用户区默认口
  candidates.push({ port: 8787, source: 'user-zone' });

  for (const c of candidates) {
    const r = await probe(c.port);
    if (r.ok) {
      const value = { port: c.port, lane: c.lane, version: r.version, source: c.source };
      cache = { at: Date.now(), value };
      return value;
    }
  }

  cache = { at: Date.now(), value: null };
  return null;
}

/** 同步视图（供 health 展示，不阻塞）。 */
export function biliCache() {
  return cache.value;
}
