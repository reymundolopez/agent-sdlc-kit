import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';

const KIT_HOOK_RE = /scripts\/hooks\/[\w-]+\.mjs/;

function real(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

export function defaultPluginsDir() {
  return process.env.BV_PLUGINS_DIR || join(process.env.HOME || homedir(), '.gemini', 'config', 'plugins');
}

/**
 * Finds every hooks file that registers this kit's lifecycle scripts
 * (scripts/hooks/*.mjs): project/workspace `.agents/hooks.json`, plus plugin dirs.
 * Files are de-duplicated by real path (symlinks collapse to one registration).
 * @returns {{source:string, hooksFile:string, realFile:string, realTarget:string}[]}
 */
export function scanRegistrations({ roots = [], pluginsDir = defaultPluginsDir() } = {}) {
  const candidates = [];
  for (const r of roots) {
    if (r) candidates.push({ source: 'project', file: join(r, '.agents', 'hooks.json') });
  }
  if (pluginsDir && existsSync(pluginsDir)) {
    try {
      for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
        candidates.push({ source: 'plugin', file: join(pluginsDir, e.name, 'hooks.json') });
      }
    } catch {}
  }
  const seen = new Map();
  for (const c of candidates) {
    if (!existsSync(c.file)) continue;
    let text;
    try { text = readFileSync(c.file, 'utf8'); } catch { continue; }
    const m = text.match(/node\s+(\S*scripts\/hooks\/[\w-]+\.mjs)/);
    if (!m || !KIT_HOOK_RE.test(text)) continue;
    const realFile = real(c.file);
    if (seen.has(realFile)) continue;
    const base = c.source === 'plugin' ? join(c.file, '..') : join(c.file, '..', '..');
    const realTarget = real(m[1].startsWith('/') ? m[1] : resolve(base, m[1]));
    seen.set(realFile, { source: c.source, hooksFile: c.file, realFile, realTarget });
  }
  return [...seen.values()];
}

/** Files under project `.agents/{agents,skills}` that shadow the kit's own (drift risk). */
export function findShadowed(roots, kitRoot) {
  const out = [];
  for (const r of new Set(roots.filter(Boolean))) {
    for (const sub of ['agents', 'skills']) {
      const dir = join(r, '.agents', sub);
      const kitDir = join(kitRoot, sub);
      if (!existsSync(dir) || !existsSync(kitDir) || real(dir) === real(kitDir)) continue;
      for (const name of readdirSync(dir)) {
        if (existsSync(join(kitDir, name))) out.push(relative(r, join(dir, name)) || name);
      }
    }
  }
  return out;
}
