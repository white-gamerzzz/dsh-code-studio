/**
 * map.js — 跨仓/跨包依赖图 + 循环依赖检测
 *
 * 目的：改一处前先看它会牵动谁。扫描一个工作区根目录下的各包清单
 * （package.json / go.mod / Cargo.toml / pyproject.toml / requirements.txt / pom.xml），
 * 把「包 → 内部被依赖包」建成有向图，标出外部依赖，并找环。
 *
 * 只认本地内部的边（依赖名命中工作区内某个包名），外部依赖只统计不建边——
 * 这样图才小、才可读。ponytail：先支持主流五种清单；遇到别的生态再按需加解析器。
 */

import { join, dirname, relative, resolve, isAbsolute, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';

const MANIFESTS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'pom.xml'];
const IGNORE_DIRS = new Set(['node_modules', '.git', '.codewrite', 'dist', 'build', 'target', '.next', 'coverage', 'vendor']);

/** 递归找出工作区内所有含清单文件的目录（限深度，防大仓爆炸）。 */
async function findPackages(root, { maxDepth = 5 } = {}) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (MANIFESTS.some((m) => names.has(m))) found.push(dir);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  await walk(root, 0);
  return found;
}

/** 从某个包的清单里读出 {name, deps:{name->version}, ecosystem}。 */
async function readManifest(dir) {
  for (const file of MANIFESTS) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (file === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
        return { name: pkg.name || basename(dir), deps, ecosystem: 'npm', file };
      } catch {
        continue;
      }
    }
    if (file === 'go.mod') {
      const name = (/^module\s+(\S+)/m.exec(text) || [])[1] || basename(dir);
      const deps = {};
      const re = /^\s*([^\s/]+\/[^\s]+)\s+v/gm;
      let m;
      while ((m = re.exec(text))) deps[m[1]] = 'go';
      return { name, deps, ecosystem: 'gomod', file };
    }
    if (file === 'Cargo.toml') {
      const name = (/^\s*name\s*=\s*"([^"]+)"/m.exec(text) || [])[1] || basename(dir);
      const deps = {};
      const re = /^\s*([A-Za-z0-9_-]+)\s*=\s*[{"]/gm;
      let m;
      while ((m = re.exec(text))) deps[m[1]] = 'cargo';
      return { name, deps, ecosystem: 'cargo', file };
    }
    if (file === 'pyproject.toml') {
      const name = (/^\s*name\s*=\s*"([^"]+)"/m.exec(text) || [])[1] || basename(dir);
      const deps = {};
      const re = /^\s*([A-Za-z0-9_.-]+)\s*[=<>!~]/gm;
      let m;
      while ((m = re.exec(text))) deps[m[1]] = 'py';
      return { name, deps, ecosystem: 'python', file };
    }
    if (file === 'requirements.txt') {
      const deps = {};
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const m = /^([A-Za-z0-9_.-]+)/.exec(t);
        if (m) deps[m[1]] = 'py';
      }
      return { name: basename(dir), deps, ecosystem: 'python', file };
    }
    if (file === 'pom.xml') {
      const name = (/<artifactId>([^<]+)<\/artifactId>/.exec(text) || [])[1] || basename(dir);
      const deps = {};
      const re = /<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g;
      let m;
      while ((m = re.exec(text))) deps[m[1]] = 'maven';
      return { name, deps, ecosystem: 'maven', file };
    }
  }
  return null;
}

/**
 * 建图。返回 {root, packages, edges:[{from,to}], externals:{name:count}, cycles:[[...]]}
 */
export async function buildGraph(root, opts = {}) {
  const dirs = await findPackages(root, opts);
  const manifests = [];
  for (const dir of dirs) {
    const m = await readManifest(dir);
    if (m) manifests.push({ ...m, dir });
  }
  // 包名 → 规范包标识（用相对 root 的目录，避免重名歧义）
  const byName = new Map();
  for (const m of manifests) {
    if (!byName.has(m.name)) byName.set(m.name, m);
  }
  const edges = [];
  const externals = {};
  const seenEdge = new Set();
  for (const m of manifests) {
    for (const dep of Object.keys(m.deps)) {
      const target = byName.get(dep);
      if (target && target.dir !== m.dir) {
        const key = `${m.dir}->${target.dir}`;
        if (!seenEdge.has(key)) {
          seenEdge.add(key);
          edges.push({ from: relative(root, m.dir) || '.', to: relative(root, target.dir) || '.' });
        }
      } else if (!target) {
        const scope = dep.startsWith('@') ? dep.split('/')[0] : dep.split('/')[0];
        externals[scope] = (externals[scope] ?? 0) + 1;
      }
    }
  }
  const nodes = manifests.map((m) => ({ name: m.name, dir: relative(root, m.dir) || '.', ecosystem: m.ecosystem, file: m.file }));
  return { root, packages: nodes, edges, externals, cycles: findCycles(nodes, edges) };
}

/** 用 DFS 在 from/to 名字图上找环。返回环数组（每环是节点序列）。 */
export function findCycles(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n.dir, []);
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...adj.keys()].map((k) => [k, WHITE]));
  const stack = [];
  const cycles = [];
  const seenCycle = new Set();

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (!color.has(next)) continue;
      if (color.get(next) === GRAY) {
        const idx = stack.indexOf(next);
        const cycle = stack.slice(idx);
        // 规范化（从字典序最小节点起），去重
        const minIdx = cycle.indexOf([...cycle].sort()[0]);
        const norm = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
        const key = norm.join('->');
        if (!seenCycle.has(key)) {
          seenCycle.add(key);
          cycles.push(norm);
        }
      } else if (color.get(next) === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) dfs(node);
  }
  return cycles;
}

/** 渲染成 Markdown 报告。 */
export async function renderMap(root) {
  const g = await buildGraph(root);
  const lines = [`## 依赖图 · ${basename(root)}`, '', `发现 ${g.packages.length} 个包，${g.edges.length} 条内部依赖边。`, ''];
  if (g.packages.length) {
    lines.push('### 包');
    for (const p of g.packages) lines.push(`- ${p.name}（${p.ecosystem}）→ \`${p.dir}/${p.file}\``);
    lines.push('');
  }
  if (g.edges.length) {
    lines.push('### 内部依赖边');
    for (const e of g.edges) lines.push(`- ${e.from} → ${e.to}`);
    lines.push('');
  }
  const extKeys = Object.keys(g.externals).sort((a, b) => g.externals[b] - g.externals[a]).slice(0, 20);
  if (extKeys.length) {
    lines.push('### 主要外部依赖（按引用计）');
    lines.push(extKeys.map((k) => `${k}(${g.externals[k]})`).join('、'));
    lines.push('');
  }
  if (g.cycles.length) {
    lines.push(`### ⚠️ 循环依赖 ${g.cycles.length} 处`);
    for (const c of g.cycles) lines.push(`- ${[...c, c[0]].join(' → ')}`);
  } else {
    lines.push('### 循环依赖：无 ✅');
  }
  return { report: lines.join('\n'), graph: g };
}
