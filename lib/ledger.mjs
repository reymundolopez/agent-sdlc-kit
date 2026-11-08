import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function getActiveIssuePath(bvDir) {
  return join(bvDir, 'state', 'ACTIVE_ISSUE');
}

export function getActiveIssueNumber(bvDir) {
  const p = getActiveIssuePath(bvDir);
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, 'utf8').trim();
      if (raw) {
        if (raw.startsWith('{')) {
          const parsed = JSON.parse(raw);
          if (parsed.issue) return Number(parsed.issue);
        } else if (Number(raw)) {
          return Number(raw);
        }
      }
    } catch {}
  }
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
    const m = branch?.match(/issue-0*(\d+)/i);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

export function getActiveIssueState(bvDir) {
  const p = getActiveIssuePath(bvDir);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      return JSON.parse(raw);
    }
    return { issue: Number(raw) };
  } catch {
    return null;
  }
}

export function setActiveIssue(bvDir, issueNum, meta = {}) {
  const p = getActiveIssuePath(bvDir);
  mkdirSync(join(bvDir, 'state'), { recursive: true });
  const data = {
    issue: Number(issueNum),
    updatedAt: new Date().toISOString(),
    ...meta
  };
  writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export function clearActiveIssue(bvDir) {
  const p = getActiveIssuePath(bvDir);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {}
  }
}

export function getLedgerPath(bvDir, issueNum) {
  const n = String(issueNum).replace(/^ISSUE-/i, '');
  return join(bvDir, 'state', `ISSUE-${n}.json`);
}

export function readLedger(bvDir, issueNum) {
  const target = issueNum || getActiveIssueNumber(bvDir);
  if (!target) return null;
  const p = getLedgerPath(bvDir, target);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeLedger(bvDir, issueNum, ledgerObj) {
  const target = issueNum || ledgerObj?.issue || getActiveIssueNumber(bvDir);
  if (!target) throw new Error('Cannot write ledger without issue number');
  const p = getLedgerPath(bvDir, target);
  mkdirSync(join(bvDir, 'state'), { recursive: true });
  writeFileSync(p, JSON.stringify(ledgerObj, null, 2), 'utf8');
  return ledgerObj;
}

export function createInitialLedger({
  issue,
  id,
  branch,
  phase = 'intake',
  orchestratorConversationId = null,
  activeConversationId = null
}) {
  return {
    issue: Number(issue),
    id: id || `ISSUE-${issue}`,
    branch: branch || `feature/issue-${issue}`,
    phase,
    orchestratorConversationId,
    activeConversationId,
    attempts: {},
    failureHashes: {},
    red: null,
    green: null,
    review: null,
    verify: null,
    pr: null
  };
}

/**
 * Normalizes error text and returns short sha256 failure hash (6 hex chars)
 */
export function computeFailureHash(verb, errorText) {
  const normalized = String(errorText || '')
    .replace(/\d+ms|\d+\.\d+s/g, '<time>')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .trim();
  return createHash('sha256')
    .update(`${verb}:${normalized}`)
    .digest('hex')
    .slice(0, 6);
}

/**
 * Records a failure in the ledger for the current phase.
 * Checks identical failure limit (default 2) and maxAttempts (default 5).
 * Returns { ledger, shouldBlock, blockReason, attempts, hash }
 */
export function recordPhaseFailure(bvDir, config, verb, errorSummary, issueNum = null) {
  const ledger = readLedger(bvDir, issueNum);
  if (!ledger) {
    return { ledger: null, shouldBlock: false, blockReason: null };
  }
  const phase = ledger.phase || 'unknown';
  ledger.attempts = ledger.attempts || {};
  ledger.failureHashes = ledger.failureHashes || {};

  ledger.attempts[phase] = (ledger.attempts[phase] || 0) + 1;
  const hash = computeFailureHash(verb, errorSummary);
  ledger.failureHashes[phase] = ledger.failureHashes[phase] || [];
  ledger.failureHashes[phase].push(hash);

  writeLedger(bvDir, ledger.issue, ledger);

  const maxAttempts = config?.maxAttempts || 5;
  const identicalLimit = config?.identicalFailureLimit || 2;

  const sameHashCount = ledger.failureHashes[phase].filter(h => h === hash).length;
  if (sameHashCount >= identicalLimit) {
    return {
      ledger,
      shouldBlock: true,
      blockReason: `Two identical failures (${hash}) in phase '${phase}' on verb '${verb}': ${errorSummary}`,
      attempts: ledger.attempts[phase],
      hash
    };
  }

  if (ledger.attempts[phase] >= maxAttempts) {
    return {
      ledger,
      shouldBlock: true,
      blockReason: `Exceeded max remediation attempts (${ledger.attempts[phase]}/${maxAttempts}) in phase '${phase}' on verb '${verb}': ${errorSummary}`,
      attempts: ledger.attempts[phase],
      hash
    };
  }

  return {
    ledger,
    shouldBlock: false,
    blockReason: null,
    attempts: ledger.attempts[phase],
    hash
  };
}
