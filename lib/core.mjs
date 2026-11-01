import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
export const KIT_ROOT = resolve(dirname(__filename), '..');

/**
 * Resolves workspace root, code repo root, and blueprint repo root
 * whether invoked from /Users/reymundolopez/BV, bv-ososapp, bv-blueprint, or bv-photoaibatch.
 */
export function resolveContext(startDir = process.cwd()) {
  let curr = resolve(startDir);
  let configPath = null;
  let configDir = null;

  // Walk up looking for .agents/sdlc.config.json
  for (let i = 0; i < 5; i++) {
    const candidate = join(curr, '.agents', 'sdlc.config.json');
    if (existsSync(candidate)) {
      configPath = candidate;
      configDir = curr;
      break;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  let config = null;
  if (configPath) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {}
  }

  if (!config) {
    // Fallback to default template
    const defaultCfgPath = join(KIT_ROOT, 'templates', 'sdlc.config.json');
    config = existsSync(defaultCfgPath)
      ? JSON.parse(readFileSync(defaultCfgPath, 'utf8'))
      : {
          repos: { backlog: 'reymundolopez/bv-blueprint', code: 'bv-ososapp' },
          phases: [],
          maxAttempts: 5,
          identicalFailureLimit: 2
        };
  }

  const baseDir = configDir || resolve(startDir);
  let workspaceRoot = baseDir;
  if (existsSync(join(baseDir, '..', 'bv-ososapp')) || existsSync(join(baseDir, '..', 'bv-blueprint'))) {
    workspaceRoot = resolve(baseDir, '..');
  }

  const codeRepoName = config?.repos?.code || 'bv-ososapp';
  let codeDir = baseDir;
  if (configDir && existsSync(join(configDir, 'package.json'))) {
    codeDir = configDir;
  } else if (existsSync(join(baseDir, codeRepoName, 'package.json'))) {
    codeDir = join(baseDir, codeRepoName);
  } else if (existsSync(join(workspaceRoot, codeRepoName, 'package.json'))) {
    codeDir = join(workspaceRoot, codeRepoName);
  } else if (existsSync(join(baseDir, 'package.json'))) {
    codeDir = baseDir;
  }

  let blueprintDir = null;
  const bpCandidates = [
    join(workspaceRoot, 'bv-blueprint'),
    join(baseDir, 'bv-blueprint'),
    join(baseDir, '..', 'bv-blueprint'),
    '/Users/reymundolopez/BV/bv-blueprint'
  ];
  for (const c of bpCandidates) {
    if (existsSync(join(c, '.git'))) {
      blueprintDir = resolve(c);
      break;
    }
  }

  // .bv directory lives in codeDir (or workspaceRoot if shared, we sync or anchor at codeDir)
  // Wait: if invoked from /Users/reymundolopez/BV or bv-ososapp, anchoring .bv in codeDir ensures single source of truth!
  const bvDir = join(codeDir, '.bv');
  mkdirSync(join(bvDir, 'state'), { recursive: true });
  mkdirSync(join(bvDir, 'logs'), { recursive: true });
  mkdirSync(join(bvDir, 'cache'), { recursive: true });
  mkdirSync(join(bvDir, 'issues'), { recursive: true });
  mkdirSync(join(bvDir, 'packets'), { recursive: true });

  return {
    kitRoot: KIT_ROOT,
    workspaceRoot,
    codeDir,
    blueprintDir,
    bvDir,
    configPath,
    config
  };
}

/**
 * Computes deterministic working tree OID in ~15ms using a temporary git index
 * without mutating .git/index:
 * GIT_INDEX_FILE=.bv/tmp.index git add -A && GIT_INDEX_FILE=.bv/tmp.index git write-tree
 */
export function computeWorkingTreeOid(repoDir, bvDir) {
  const tmpIndex = join(bvDir || join(repoDir, '.bv'), `tmp.${process.pid}.index`);
  const gitIndex = join(repoDir, '.git', 'index');
  try {
    mkdirSync(dirname(tmpIndex), { recursive: true });
    if (existsSync(gitIndex)) {
      try {
        copyFileSync(gitIndex, tmpIndex);
      } catch {}
    }
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const addRes = spawnSync('git', ['add', '-A'], { cwd: repoDir, env, encoding: 'utf8', timeout: 10000 });
    if (addRes.status !== 0) {
      return 'untracked-tree';
    }
    const writeRes = spawnSync('git', ['write-tree'], { cwd: repoDir, env, encoding: 'utf8', timeout: 10000 });
    if (writeRes.status !== 0) {
      return 'untracked-tree';
    }
    return writeRes.stdout.trim();
  } finally {
    try {
      if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
    } catch {}
  }
}

/**
 * Computes git blob hash for a single file (git hash-object <file>)
 */
export function computeFileBlobHash(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath);
    const header = `blob ${content.length}\0`;
    return createHash('sha1').update(header).update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Cache key = sha256(verb, normalizedArgs, workingTreeOid)
 */
export function getCacheKey(verb, args, workingTreeOid) {
  const filteredArgs = (args || []).filter(a => a !== '--no-cache');
  const payload = JSON.stringify({ verb, args: filteredArgs, workingTreeOid });
  return createHash('sha256').update(payload).digest('hex');
}

export function readCache(bvDir, cacheKey) {
  const file = join(bvDir, 'cache', `${cacheKey}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(bvDir, cacheKey, resultObj) {
  const file = join(bvDir, 'cache', `${cacheKey}.json`);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(resultObj, null, 2), 'utf8');
  } catch {}
}

/**
 * Writes full log to .bv/logs/<verb>-<n>.log
 */
export function writeVerbLog(bvDir, verb, issueNum, logContent) {
  const suffix = issueNum || Date.now();
  const relPath = `.bv/logs/${verb}-${suffix}.log`;
  const fullPath = join(bvDir, 'logs', `${verb}-${suffix}.log`);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, String(logContent || ''), 'utf8');
  return relPath;
}

/**
 * Emits standard <= 40 line JSON output and exits with strict exit code:
 * 0 ok | 2 failed (retryable) | 3 blocked (human) | 4 misuse
 */
export function emitResult({ ok, summary, next, artifacts = [], cached = false, data = undefined }, exitCode = 0) {
  const payload = {
    ok: Boolean(ok),
    summary: String(summary || ''),
    next: next || null,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    cached: Boolean(cached)
  };
  if (data !== undefined) {
    payload.data = data;
  }
  const formatted = JSON.stringify(payload, null, 2);
  const lines = formatted.split('\n');
  if (lines.length > 40) {
    // Compact if exceeding 40 lines
    console.log(JSON.stringify(payload));
  } else {
    console.log(formatted);
  }
  process.exit(exitCode);
}

export function parseFlags(argList) {
  const named = {};
  const positional = [];
  for (let i = 0; i < argList.length; i++) {
    const raw = argList[i];
    if (raw.startsWith('--')) {
      const stripped = raw.slice(2);
      if (stripped.includes('=')) {
        const eqIdx = stripped.indexOf('=');
        named[stripped.slice(0, eqIdx)] = stripped.slice(eqIdx + 1);
      } else {
        const next = argList[i + 1];
        if (next && !next.startsWith('--')) {
          named[stripped] = next;
          i++;
        } else {
          named[stripped] = true;
        }
      }
    } else if (raw === '-h') {
      named.help = true;
    } else {
      positional.push(raw);
    }
  }
  return { named, positional };
}
