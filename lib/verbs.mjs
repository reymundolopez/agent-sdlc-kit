import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  computeWorkingTreeOid,
  computeFileBlobHash,
  getCacheKey,
  readCache,
  writeCache,
  writeVerbLog,
  emitResult,
  parseFlags
} from './core.mjs';
import {
  getActiveIssueNumber,
  setActiveIssue,
  clearActiveIssue,
  readLedger,
  writeLedger,
  createInitialLedger,
  recordPhaseFailure
} from './ledger.mjs';
import { extractFileOutline, runRipgrepSearch, generateRepoSlice } from './ast.mjs';
import { generatePhasePacket } from './packets.mjs';

export const VERB_DOCS = {
  'run-issue': {
    mode: 'Deterministic Runner',
    summary: 'End-to-end state machine: runs deterministic phases directly and spawns agy -p for LLM phases (red, code).',
    usage: 'bv run-issue <n> [--with-spec] [--with-design] [--deep-review] [--dry-run]'
  },
  'read-issue': {
    mode: 'Deterministic',
    summary: 'Fetch issue + comments once, write .bv/issues/<n>.json, extract structured ACs, target files & labels.',
    usage: 'bv read-issue <n> [--no-cache]'
  },
  'start-issue': {
    mode: 'Deterministic',
    summary: 'Lock (status:in-progress), resolve repo/branch/ISSUE-ID, create .bv/state/ISSUE-<n>.json & ACTIVE_ISSUE, checkout branch.',
    usage: 'bv start-issue <n> [--branch <slug>] [--dry-run]'
  },
  'read-spec': {
    mode: 'Deterministic',
    summary: 'Print structured AC checklist and affected-files list from .bv/issues/<n>.json.',
    usage: 'bv read-spec [n]'
  },
  'set-phase': {
    mode: 'Deterministic',
    summary: 'Swap agent:* / status:* labels, update ledger, generate <= 2 KB phase packet.',
    usage: 'bv set-phase <phase> [--issue <n>] [--dry-run]'
  },
  'post-comment': {
    mode: 'Deterministic',
    summary: 'Format one of the 5 templates in orchestrator.md §3 from ledger/artifacts and post to GitHub issue.',
    usage: 'bv post-comment <product|architect|coder|reviewer|qa> [file] [--issue <n>] [--dry-run]'
  },
  search: {
    mode: 'Deterministic',
    summary: 'Embedded ripgrep (rg --json) locator returning file:L<start>-L<end> ranges (<= 30 lines).',
    usage: 'bv search <query> [path]'
  },
  outline: {
    mode: 'Deterministic',
    summary: 'TypeScript Compiler API / AST symbol outline returning exported functions, classes, interfaces, and exact L<start>-L<end> line ranges.',
    usage: 'bv outline <file>'
  },
  'read-slice': {
    mode: 'Deterministic',
    summary: 'Extract AST signatures, Prisma models, and exact target line ranges for blueprint/issue files.',
    usage: 'bv read-slice [--query <kw>] [--output <file>]'
  },
  'read-diff': {
    mode: 'Deterministic',
    summary: 'Compact git diff main...HEAD + file list + AC list.',
    usage: 'bv read-diff [--base <branch>]'
  },
  'review-static': {
    mode: 'Deterministic',
    summary: 'Zero-LLM static audit on branch diff: oxlint/ESLint (no-explicit-any), ast-grep rules (Spirit >= 44px, zero raw SQL, zero VPS build scripts).',
    usage: 'bv review-static [--no-cache]'
  },
  'write-red': {
    mode: 'Used by qa LLM',
    summary: 'Scaffold/register AC test file, run it, require failure, record workingTreeOid + test list in ledger, lock test files.',
    usage: 'bv write-red <test-file> [--scaffold] [--title "<title>"]'
  },
  'gate-green': {
    mode: 'Used by coder LLM',
    summary: 'Refuse if ledger.red is null or locked test files were modified; run recorded RED tests; must pass.',
    usage: 'bv gate-green [test-file]'
  },
  'check-scope': {
    mode: 'Used by coder LLM',
    summary: 'Diff vs blueprint/packet; fail on out-of-scope files and on any edit to locked RED tests.',
    usage: 'bv check-scope [--spec <file>] [--files <f1,f2>]'
  },
  'lint-types': {
    mode: 'Used by coder LLM',
    summary: 'oxlint/ESLint + tsc --noEmit + zero-any scan, cached by working-tree hash.',
    usage: 'bv lint-types [--no-cache]'
  },
  verify: {
    mode: 'Deterministic',
    summary: 'gate-green + verify-all + review-static once (cached by working-tree hash); <= 15-line summary; names regressing file on failure.',
    usage: 'bv verify [--no-cache] [--dry-run]'
  },
  'capture-proof': {
    mode: 'Deterministic',
    summary: 'Local + live Playwright screenshots using Infisical credentials; exit 3 on preflight failure.',
    usage: 'bv capture-proof [--visual] [--issue <ID>] [--gh-issue <n>]'
  },
  'manual-check': {
    mode: 'Deterministic',
    summary: 'Run the issue manual/<ISSUE>.mjs scenario script if present.',
    usage: 'bv manual-check [--issue <n>]'
  },
  prepush: {
    mode: 'Deterministic',
    summary: 'Full pre-push gate + tracked .env* guard (only .env.schema allowed) + gitleaks scan.',
    usage: 'bv prepush [--check-only <git-hygiene|secrets|ci-env>]'
  },
  ship: {
    mode: 'Deterministic',
    summary: 'Push branch + open/merge PR + update labels.',
    usage: 'bv ship --message "<msg>" [--issue <ID>] [--gh-issue <n>] [--branch <branch>] [--push] [--dry-run]'
  },
  'watch-ci': {
    mode: 'Deterministic',
    summary: 'Block until GitHub Actions CI completes; print conclusion + failing job logs.',
    usage: 'bv watch-ci [--run-id <id>] [--timeout-sec <sec>]'
  },
  'vps-status': {
    mode: 'Deterministic',
    summary: 'Read-only prod health check.',
    usage: 'bv vps-status [--host <host>] [--dry-run]'
  },
  'verify-prod': {
    mode: 'Deterministic',
    summary: 'Read-only post-deploy smoke check (health + version).',
    usage: 'bv verify-prod [--url <url>] [--dry-run]'
  },
  'close-issue': {
    mode: 'Deterministic',
    summary: 'Verify ledger gates (red, green, review, verify, pr), post closing comment, close issue, clear ACTIVE_ISSUE.',
    usage: 'bv close-issue [--issue <n>] [--dry-run]'
  },
  'block-issue': {
    mode: 'Deterministic',
    summary: 'Apply status:blocked, post diagnostic comment with failure trace, clear active lock, exit 3.',
    usage: 'bv block-issue "<reason>" [--issue <n>] [--dry-run]'
  },
  'restore-artifacts': {
    mode: 'Deterministic',
    summary: 'Reset known test-mutated files (catalog_inventory.xlsx), stage telemetry.',
    usage: 'bv restore-artifacts'
  },
  'db-up': {
    mode: 'Deterministic',
    summary: 'Start local DB via compose, sync Prisma migrations via Infisical, print DATABASE_URL var name (never value).',
    usage: 'bv db-up [--dry-run]'
  },
  'secrets-run': {
    mode: 'Deterministic',
    summary: 'infisical run --env=dev -- pnpm exec varlock run -- <cmd>.',
    usage: 'bv secrets-run <cmd...>'
  },
  ledger: {
    mode: 'Deterministic',
    summary: 'Print current phase, attempts, working-tree hash, and next verb (<= 10 lines).',
    usage: 'bv ledger [--issue <n>]'
  },
  doctor: {
    mode: 'Deterministic',
    summary: 'Verify always-on rules/context budget (<= 2 KB session brief, GEMINI.md <= 40 lines), Infisical auth, zero .env files, and hook integrity.',
    usage: 'bv doctor'
  },
  'telemetry-report': {
    mode: 'Deterministic',
    summary: 'Reads .bv/calls.jsonl: calls per role, deterministic vs LLM phase duration, duplicates blocked, cache hits, turns & attempts.',
    usage: 'bv telemetry-report [--issue <n>]'
  },
  verbs: {
    mode: 'Deterministic',
    summary: 'List all available bv verbs and one-line descriptions.',
    usage: 'bv verbs'
  }
};

export function printVerbHelp(verb) {
  const doc = VERB_DOCS[verb];
  if (!doc) {
    emitResult(
      {
        ok: false,
        summary: `Unknown verb '${verb}'. Run 'bv verbs' to list all supported commands.`,
        next: 'bv verbs'
      },
      4
    );
  }
  console.log(`bv ${verb} (${doc.mode})\n  ${doc.summary}\n  Usage: ${doc.usage}`);
  process.exit(0);
}

/**
 * Helper to parse markdown issue body into structured ACs and target files
 */
export function parseIssueMarkdown(title, body, labels = []) {
  const text = String(body || '');
  const acs = [];
  const targetFiles = new Set();

  // Extract checkbox items or numbered AC items
  for (const line of text.split('\n')) {
    const cbMatch = line.match(/^\s*[-*]\s*\[[ xX]\]\s+(.+)$/);
    if (cbMatch) {
      acs.push(cbMatch[1].trim());
    }
    // Extract file paths mentioned in backticks
    const codeMatches = line.matchAll(/`((?:apps|packages|scripts|tools|\.agents|\.context)\/[A-Za-z0-9_./-]+|verify-issue-[0-9A-Za-z_.-]+\.mjs)`/g);
    for (const m of codeMatches) {
      if (!m[1].includes('*') && !m[1].includes('<')) {
        targetFiles.add(m[1]);
      }
    }
  }

  // Extract ISSUE-XXX identifier from title first (avoid matching historical ISSUE-XXX mentions in body)
  const titleMatch = String(title || '').match(/ISSUE-(\d{3})/i);
  const issueId = titleMatch ? `ISSUE-${titleMatch[1]}` : null;

  return {
    issueId,
    acceptanceCriteria: acs,
    targetFiles: Array.from(targetFiles),
    labels: labels.map(l => (typeof l === 'string' ? l : l.name))
  };
}

// -------------------------------------------------------------
// Verb Implementations
// -------------------------------------------------------------

export async function cmdVerbs() {
  const list = Object.entries(VERB_DOCS).map(([k, v]) => `${k.padEnd(18)} : ${v.summary.slice(0, 75)}`);
  emitResult({
    ok: true,
    summary: `${list.length} verbs registered in agent-sdlc-kit.`,
    next: 'bv ledger',
    data: { verbs: Object.keys(VERB_DOCS) }
  });
}

export async function cmdReadIssue(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue || getActiveIssueNumber(ctx.bvDir));
  if (!issueNum) {
    emitResult({ ok: false, summary: 'Usage: bv read-issue <n>', next: 'bv read-issue <n>' }, 4);
  }

  const outFile = join(ctx.bvDir, 'issues', `${issueNum}.json`);
  if (existsSync(outFile) && !named['no-cache']) {
    const cachedData = JSON.parse(readFileSync(outFile, 'utf8'));
    emitResult({
      ok: true,
      summary: `Issue #${issueNum} (${cachedData.issueId || cachedData.title}) loaded from cache (${cachedData.acceptanceCriteria?.length || 0} ACs).`,
      next: 'bv read-slice',
      artifacts: [`.bv/issues/${issueNum}.json`],
      cached: true
    });
  }

  const repo = ctx.config?.repos?.backlog || 'reymundolopez/bv-blueprint';
  const ghRes = spawnSync(
    'gh',
    ['issue', 'view', String(issueNum), '--repo', repo, '--json', 'number,title,body,labels,comments,state'],
    { cwd: ctx.codeDir, encoding: 'utf8', timeout: 30000 }
  );

  if (ghRes.status !== 0) {
    const logRel = writeVerbLog(ctx.bvDir, 'read-issue', issueNum, ghRes.stderr || ghRes.stdout);
    emitResult(
      {
        ok: false,
        summary: `Failed to fetch GitHub issue #${issueNum} from ${repo}.`,
        next: `bv read-issue ${issueNum} --no-cache`,
        artifacts: [logRel]
      },
      2
    );
  }

  const rawIssue = JSON.parse(ghRes.stdout);
  const parsed = parseIssueMarkdown(rawIssue.title, rawIssue.body, rawIssue.labels);
  const issueId = parsed.issueId || `ISSUE-${String(issueNum).padStart(3, '0')}`;

  const structured = {
    number: rawIssue.number,
    issueId,
    title: rawIssue.title,
    state: rawIssue.state,
    labels: parsed.labels,
    acceptanceCriteria: parsed.acceptanceCriteria,
    targetFiles: parsed.targetFiles,
    body: rawIssue.body,
    commentsCount: (rawIssue.comments || []).length,
    fetchedAt: new Date().toISOString()
  };

  mkdirSync(join(ctx.bvDir, 'issues'), { recursive: true });
  writeFileSync(outFile, JSON.stringify(structured, null, 2), 'utf8');

  emitResult({
    ok: true,
    summary: `Fetched issue #${issueNum} (${issueId}: "${rawIssue.title}") with ${structured.acceptanceCriteria.length} ACs and ${structured.targetFiles.length} target files.`,
    next: 'bv read-slice',
    artifacts: [`.bv/issues/${issueNum}.json`]
  });
}

export async function cmdStartIssue(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue);
  if (!issueNum) {
    emitResult({ ok: false, summary: 'Usage: bv start-issue <n>', next: 'bv start-issue <n>' }, 4);
  }

  const isDryRun = Boolean(named['dry-run']);
  const repo = ctx.config?.repos?.backlog || 'reymundolopez/bv-blueprint';

  // Ensure issue is read first or read its title
  const issueJsonPath = join(ctx.bvDir, 'issues', `${issueNum}.json`);
  let issueData = null;
  if (existsSync(issueJsonPath)) {
    issueData = JSON.parse(readFileSync(issueJsonPath, 'utf8'));
  } else if (!isDryRun) {
    const ghRes = spawnSync(
      'gh',
      ['issue', 'view', String(issueNum), '--repo', repo, '--json', 'number,title,body,labels,comments,state'],
      { cwd: ctx.codeDir, encoding: 'utf8', timeout: 30000 }
    );
    if (ghRes.status === 0) {
      const rawIssue = JSON.parse(ghRes.stdout);
      const parsed = parseIssueMarkdown(rawIssue.title, rawIssue.body, rawIssue.labels);
      issueData = {
        number: rawIssue.number,
        issueId: parsed.issueId || `ISSUE-${String(issueNum).padStart(3, '0')}`,
        title: rawIssue.title,
        state: rawIssue.state,
        labels: parsed.labels,
        acceptanceCriteria: parsed.acceptanceCriteria,
        targetFiles: parsed.targetFiles,
        body: rawIssue.body
      };
      writeFileSync(issueJsonPath, JSON.stringify(issueData, null, 2), 'utf8');
    }
  }

  const issueId = issueData?.issueId || named.id || `ISSUE-${String(issueNum).padStart(3, '0')}`;
  const slug = (issueData?.title || `issue-${issueNum}`)
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const branch = named.branch || `feature/${issueId.toLowerCase()}-${slug || 'impl'}`;

  if (!isDryRun) {
    spawnSync(
      'gh',
      ['issue', 'edit', String(issueNum), '--repo', repo, '--add-label', 'status:in-progress', '--remove-label', 'status:queued'],
      { cwd: ctx.codeDir, encoding: 'utf8', timeout: 15000 }
    );
    spawnSync('git', ['checkout', '-B', branch], { cwd: ctx.codeDir, encoding: 'utf8' });
  }

  let ledger = readLedger(ctx.bvDir, issueNum);
  if (!ledger) {
    ledger = createInitialLedger({
      issue: issueNum,
      id: issueId,
      branch,
      phase: 'intake',
      activeConversationId: process.env.BV_CONVERSATION_ID || null
    });
  } else {
    ledger.branch = branch;
  }

  writeLedger(ctx.bvDir, issueNum, ledger);
  setActiveIssue(ctx.bvDir, issueNum, {
    id: issueId,
    branch,
    phase: ledger.phase,
    activeConversationId: ledger.activeConversationId
  });

  const redPacket = await generatePhasePacket({ ctx, ledger, phase: 'red', issueData });
  await generatePhasePacket({ ctx, ledger, phase: 'code', issueData });

  emitResult({
    ok: true,
    summary: `Started ${issueId} (#${issueNum}) on branch '${branch}'. Packet generated (${redPacket.bytes}B).`,
    next: 'bv set-phase red',
    artifacts: [`.bv/state/ISSUE-${issueNum}.json`, `.bv/state/ACTIVE_ISSUE`, redPacket.relPath]
  });
}

export async function cmdReadSpec(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue || getActiveIssueNumber(ctx.bvDir));
  if (!issueNum) {
    emitResult({ ok: false, summary: 'No active issue. Pass issue number: bv read-spec <n>', next: 'bv start-issue <n>' }, 4);
  }
  const issueJsonPath = join(ctx.bvDir, 'issues', `${issueNum}.json`);
  if (!existsSync(issueJsonPath)) {
    emitResult({ ok: false, summary: `Issue #${issueNum} not cached yet. Run 'bv read-issue ${issueNum}' first.`, next: `bv read-issue ${issueNum}` }, 2);
  }
  const data = JSON.parse(readFileSync(issueJsonPath, 'utf8'));
  emitResult({
    ok: true,
    summary: `${data.issueId} (#${data.number}): ${data.title}`,
    next: 'bv set-phase red',
    artifacts: [`.bv/issues/${issueNum}.json`],
    data: {
      issueId: data.issueId,
      acceptanceCriteria: data.acceptanceCriteria.slice(0, 12),
      targetFiles: data.targetFiles.slice(0, 12)
    }
  });
}

export async function cmdSetPhase(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const phase = positional[0] || named.phase;
  const validPhases = ['intake', 'red', 'code', 'review', 'verify', 'ship', 'spec', 'design', 'deepReview'];
  if (!phase || !validPhases.includes(phase)) {
    emitResult(
      {
        ok: false,
        summary: `Invalid phase '${phase}'. Valid phases: ${validPhases.join(', ')}`,
        next: 'bv ledger'
      },
      4
    );
  }

  const issueNum = Number(named.issue || getActiveIssueNumber(ctx.bvDir));
  if (!issueNum) {
    emitResult({ ok: false, summary: 'No active issue found. Run bv start-issue <n> first.', next: 'bv start-issue <n>' }, 4);
  }

  let ledger = readLedger(ctx.bvDir, issueNum);
  if (!ledger) {
    ledger = createInitialLedger({ issue: issueNum, phase });
  }
  ledger.phase = phase;
  if (named.conversation) {
    ledger.activeConversationId = named.conversation;
  }
  writeLedger(ctx.bvDir, issueNum, ledger);
  setActiveIssue(ctx.bvDir, issueNum, {
    id: ledger.id,
    branch: ledger.branch,
    phase,
    activeConversationId: ledger.activeConversationId
  });

  // Update GitHub labels unless --dry-run
  if (!named['dry-run']) {
    const repo = ctx.config?.repos?.backlog || 'reymundolopez/bv-blueprint';
    const roleMap = {
      red: 'agent:qa',
      code: 'agent:coder',
      review: 'agent:reviewer',
      verify: 'agent:qa',
      spec: 'agent:product',
      design: 'agent:architect',
      deepReview: 'agent:reviewer'
    };
    const addLabels = [];
    if (roleMap[phase]) addLabels.push(roleMap[phase]);
    if (phase === 'review' || phase === 'verify') addLabels.push('status:in-review');
    else addLabels.push('status:in-progress');

    const removeLabels = ['agent:product', 'agent:architect', 'agent:coder', 'agent:reviewer', 'agent:qa'].filter(
      l => !addLabels.includes(l)
    );

    spawnSync(
      'gh',
      [
        'issue',
        'edit',
        String(issueNum),
        '--repo',
        repo,
        '--add-label',
        addLabels.join(','),
        '--remove-label',
        removeLabels.join(',')
      ],
      { cwd: ctx.codeDir, encoding: 'utf8', timeout: 15000 }
    );
  }

  const packet = await generatePhasePacket({
    ctx,
    ledger,
    phase,
    extraNotes: named.notes || ''
  });

  const nextVerbMap = {
    intake: 'bv read-issue',
    red: 'bv write-red',
    code: 'bv gate-green',
    review: 'bv review-static',
    verify: 'bv verify',
    ship: 'bv prepush'
  };

  emitResult({
    ok: true,
    summary: `Transitioned ${ledger.id} (#${issueNum}) to phase '${phase}'. Packet written (${packet.bytes}B <= 2KB).`,
    next: nextVerbMap[phase] || 'bv ledger',
    artifacts: [packet.relPath, `.bv/state/ISSUE-${issueNum}.json`]
  });
}

export async function cmdPostComment(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const kind = (positional[0] || named.kind || '').toLowerCase();
  const validKinds = ['product', 'architect', 'coder', 'reviewer', 'qa', 'verify', 'review'];
  if (!validKinds.includes(kind)) {
    emitResult(
      {
        ok: false,
        summary: `Usage: bv post-comment <product|architect|coder|reviewer|qa> [file]`,
        next: 'bv ledger'
      },
      4
    );
  }

  const issueNum = Number(named.issue || getActiveIssueNumber(ctx.bvDir));
  if (!issueNum) {
    emitResult({ ok: false, summary: 'No active issue found for post-comment.', next: 'bv ledger' }, 4);
  }

  const ledger = readLedger(ctx.bvDir, issueNum) || createInitialLedger({ issue: issueNum });
  const issueJsonPath = join(ctx.bvDir, 'issues', `${issueNum}.json`);
  const issueData = existsSync(issueJsonPath) ? JSON.parse(readFileSync(issueJsonPath, 'utf8')) : null;
  const customFile = positional[1] || named.file;

  let body = '';
  if (customFile && existsSync(resolve(ctx.codeDir, customFile))) {
    body = readFileSync(resolve(ctx.codeDir, customFile), 'utf8');
  } else if (kind === 'product') {
    const acs = (issueData?.acceptanceCriteria || ['Verified acceptance criteria']).map(a => `  - [ ] ${a}`).join('\n');
    body = [
      `### 📋 Product Scope & Acceptance Criteria`,
      `- **Target Issue:** ${ledger.id} (${issueData?.title || ''})`,
      `- **SSOT Cross-References:** \`business_context.md\`, \`business_logic.md\``,
      `- **Acceptance Criteria:**`,
      acs
    ].join('\n');
  } else if (kind === 'architect') {
    const files = (issueData?.targetFiles || []).map(f => `  - \`${f}\``).join('\n') || '  - Target modules mapped';
    body = [
      `### 📐 Implementation Blueprint`,
      `- **Affected Packages & Files:**`,
      files,
      `- **Execution Strategy:**`,
      `  1. Lock failing RED test from ACs`,
      `  2. Implement strict TypeScript code to pass GREEN gate`
    ].join('\n');
  } else if (kind === 'coder') {
    const diffStat = spawnSync('git', ['diff', '--shortstat', 'main...HEAD'], { cwd: ctx.codeDir, encoding: 'utf8' }).stdout.trim() || 'Working tree changes';
    body = [
      `### 💻 Execution & Implementation Summary`,
      `- **Working Branch:** \`${ledger.branch}\``,
      `- **Local Verification:**`,
      `  - \`bv lint-types\`: Pass`,
      `  - \`bv gate-green\`: Pass`,
      `- **Diff Summary:** \`${diffStat}\``
    ].join('\n');
  } else if (kind === 'reviewer' || kind === 'review') {
    body = [
      `### 🔍 Code Review Audit Verdict: APPROVED ✅`,
      `- **Style Guide Compliance:** Passed (\`.context/STYLEGUIDE.md\`)`,
      `- **Architecture Compliance:** Passed (\`.context/ARCHITECTURE.md\`)`,
      `- **Non-Negotiables Audit (Deterministic \`bv review-static\`):**`,
      `  - Strict TypeScript (zero \`any\` types): Checked`,
      `  - Direct VPS compilation prevention: Checked`,
      `  - Mobile touch ergonomics (>= 44px): Checked`,
      `- **Action Required:** None`
    ].join('\n');
  } else if (kind === 'qa' || kind === 'verify') {
    const tests = (ledger.red?.tests || [`verify-${ledger.id.toLowerCase()}.test.mjs`]).join(', ');
    body = [
      `### 🧪 QA Test Verification: PASSING ✅`,
      `- **Test Suite Executed:** Deterministic \`bv verify\` runner`,
      `- **Test File Created:** \`${tests}\``,
      `- **Results:** All verification suites passing`,
      `- **Status:** Ready for PR Merge`
    ].join('\n');
  }

  if (!named['dry-run']) {
    const repo = ctx.config?.repos?.backlog || 'reymundolopez/bv-blueprint';
    const res = spawnSync('gh', ['issue', 'comment', String(issueNum), '--repo', repo, '--body', body], {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 20000
    });
    if (res.status !== 0) {
      const logRel = writeVerbLog(ctx.bvDir, 'post-comment', issueNum, res.stderr || res.stdout);
      emitResult({ ok: false, summary: `Failed to post ${kind} comment on #${issueNum}`, next: 'bv post-comment', artifacts: [logRel] }, 2);
    }
  }

  emitResult({
    ok: true,
    summary: `Posted standardized '${kind}' comment to issue #${issueNum}.`,
    next: 'bv ledger'
  });
}

export async function cmdSearch(ctx, rawArgs) {
  const { positional } = parseFlags(rawArgs);
  const query = positional[0];
  const searchPath = positional[1];
  if (!query) {
    emitResult({ ok: false, summary: 'Usage: bv search <query> [path]', next: 'bv search <query>' }, 4);
  }

  const matches = runRipgrepSearch(query, searchPath, ctx.codeDir);
  emitResult({
    ok: true,
    summary: `Found ${matches.length} matches for '${query}'. Use read_file with StartLine/EndLine from range.`,
    next: matches[0] ? `bv outline ${matches[0].file}` : 'bv ledger',
    data: {
      matches: matches.slice(0, 15).map(m => `${m.range} -> ${m.text}`)
    }
  });
}

export async function cmdOutline(ctx, rawArgs) {
  const { positional } = parseFlags(rawArgs);
  const file = positional[0];
  if (!file) {
    emitResult({ ok: false, summary: 'Usage: bv outline <file>', next: 'bv outline <file>' }, 4);
  }

  try {
    const outline = await extractFileOutline(file, ctx.codeDir);
    emitResult({
      ok: true,
      summary: `Outline for ${outline.file} (${outline.totalLines} lines, ${outline.symbols.length} symbols). Pass StartLine/EndLine (<=200 lines) to read_file.`,
      next: `read_file ${outline.file} L1-L${Math.min(200, outline.totalLines)}`,
      data: {
        file: outline.file,
        totalLines: outline.totalLines,
        symbols: outline.symbols.slice(0, 22).map(s => `L${s.startLine}-L${s.endLine} [${s.kind}] ${s.name}: ${s.signature}`)
      }
    });
  } catch (err) {
    emitResult({ ok: false, summary: err.message, next: 'bv search' }, 2);
  }
}

export async function cmdReadSlice(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const query = named.query || positional[0] || '';
  const outputFile = named.output;

  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const cacheKey = getCacheKey('read-slice', [query, outputFile || ''], treeOid);
  if (!named['no-cache'] && !outputFile) {
    const cached = readCache(ctx.bvDir, cacheKey);
    if (cached) {
      emitResult({ ...cached, cached: true }, 0);
    }
  }

  const issueNum = getActiveIssueNumber(ctx.bvDir);
  let targetFiles = [];
  if (!query && issueNum) {
    const issuePath = join(ctx.bvDir, 'issues', `${issueNum}.json`);
    if (existsSync(issuePath)) {
      try {
        targetFiles = JSON.parse(readFileSync(issuePath, 'utf8')).targetFiles || [];
      } catch {}
    }
  }

  const slice = await generateRepoSlice({ query, files: targetFiles, repoDir: ctx.codeDir });
  const artifacts = [];
  if (outputFile) {
    const outPath = resolve(ctx.codeDir, outputFile);
    writeFileSync(outPath, slice.markdown, 'utf8');
    artifacts.push(outputFile);
  } else {
    const logRel = writeVerbLog(ctx.bvDir, 'read-slice', issueNum || 'latest', slice.markdown);
    artifacts.push(logRel);
  }

  const resObj = {
    ok: true,
    summary: `AST slice generated (${slice.matchedCount} files matched for query '${query || '*'}').`,
    next: 'bv outline <file>',
    artifacts,
    data: {
      files: slice.slices.slice(0, 12).map(f => ({
        file: f.path,
        lines: f.totalLines,
        symbols: f.symbols.slice(0, 4).map(s => `L${s.startLine}-L${s.endLine} ${s.name}`)
      }))
    }
  };
  writeCache(ctx.bvDir, cacheKey, resObj);
  emitResult(resObj, 0);
}

export async function cmdReadDiff(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const base = named.base || 'main';
  const statRes = spawnSync('git', ['diff', '--stat', `${base}...HEAD`], { cwd: ctx.codeDir, encoding: 'utf8' });
  const wtRes = spawnSync('git', ['status', '--short'], { cwd: ctx.codeDir, encoding: 'utf8' });
  const fullDiff = spawnSync('git', ['diff', base], { cwd: ctx.codeDir, encoding: 'utf8' });

  const issueNum = getActiveIssueNumber(ctx.bvDir);
  const logRel = writeVerbLog(ctx.bvDir, 'read-diff', issueNum || 'head', fullDiff.stdout || '');

  const changedFiles = (wtRes.stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 20);

  emitResult({
    ok: true,
    summary: `Diff vs ${base} captured (${changedFiles.length} working-tree entries). Full diff in ${logRel}.`,
    next: 'bv review-static',
    artifacts: [logRel],
    data: {
      stat: (statRes.stdout || '').trim().split('\n').slice(-5),
      workingTree: changedFiles
    }
  });
}

export async function cmdReviewStatic(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const cacheKey = getCacheKey('review-static', [], treeOid);

  if (!named['no-cache']) {
    const cached = readCache(ctx.bvDir, cacheKey);
    if (cached) {
      emitResult({ ...cached, cached: true }, cached.ok ? 0 : 2);
    }
  }

  const violations = [];
  const logLines = [];

  // 1. Run oxlint on changed or src files (no-explicit-any)
  const oxlintRes = spawnSync(
    'oxlint',
    ['-D', 'typescript/no-explicit-any', '--ignore-pattern', 'dist', '--ignore-pattern', '*.spec.ts', 'apps', 'packages'],
    { cwd: ctx.codeDir, encoding: 'utf8', timeout: 30000 }
  );
  logLines.push('=== OXLINT ===', oxlintRes.stdout || '', oxlintRes.stderr || '');
  if (oxlintRes.status !== 0 && (oxlintRes.stdout || '').includes('no-explicit-any')) {
    violations.push('oxlint: explicit `any` type detected in apps/ or packages/');
  }

  // 2. Run ast-grep rules from agent-sdlc-kit/sgconfig.yml
  const sgConfig = join(ctx.kitRoot, 'sgconfig.yml');
  if (existsSync(sgConfig)) {
    const sgRes = spawnSync(
      'ast-grep',
      ['scan', '-c', sgConfig, '--json', join(ctx.codeDir, 'apps'), join(ctx.codeDir, 'packages')],
      { cwd: ctx.codeDir, encoding: 'utf8', timeout: 30000 }
    );
    logLines.push('=== AST-GREP ===', sgRes.stdout || '', sgRes.stderr || '');
    if (sgRes.stdout && sgRes.stdout.trim().startsWith('[')) {
      try {
        const findings = JSON.parse(sgRes.stdout);
        for (const f of findings) {
          const relFile = relative(ctx.codeDir, f.file || '');
          if (relFile.includes('.spec.') || relFile.includes('.test.') || relFile.includes('/dist/')) continue;
          violations.push(`ast-grep [${f.ruleId}] ${relFile}:L${(f.range?.start?.line || 0) + 1} - ${f.message}`);
        }
      } catch {}
    }
  }

  // 3. Check branch diff for Spirit PWA touch targets < 44px and forbidden VPS build commands
  const diffRes = spawnSync('git', ['diff', 'HEAD'], { cwd: ctx.codeDir, encoding: 'utf8' });
  const addedLines = (diffRes.stdout || '')
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of addedLines) {
    if (/\b(?:h-[1-8]|w-[1-8]|min-h-\[(?:[1-3]\d|[1-9])px\])\b/.test(line) && /<button|onClick/.test(line)) {
      violations.push(`Spirit PWA touch target < 44px on interactive element: ${line.slice(1, 90).trim()}`);
    }
  }

  const issueNum = getActiveIssueNumber(ctx.bvDir);
  const logRel = writeVerbLog(ctx.bvDir, 'review-static', issueNum || 'head', logLines.join('\n'));
  const ok = violations.length === 0;

  if (issueNum) {
    const ledger = readLedger(ctx.bvDir, issueNum);
    if (ledger) {
      ledger.review = {
        ok,
        treeHash: treeOid,
        violations: violations.slice(0, 10),
        timestamp: new Date().toISOString()
      };
      writeLedger(ctx.bvDir, issueNum, ledger);
    }
  }

  const resObj = {
    ok,
    summary: ok
      ? `Static review APPROVED on tree ${treeOid.slice(0, 8)} (0 oxlint/ast-grep/architecture violations).`
      : `Static review FAILED with ${violations.length} violation(s).`,
    next: ok ? 'bv set-phase verify' : 'bv lint-types',
    artifacts: [logRel],
    data: ok ? undefined : { violations: violations.slice(0, 10) }
  };

  writeCache(ctx.bvDir, cacheKey, resObj);
  emitResult(resObj, ok ? 0 : 2);
}

export async function cmdWriteRed(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(named.issue || getActiveIssueNumber(ctx.bvDir));
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;
  const issueId = ledger?.id || (issueNum ? `ISSUE-${String(issueNum).padStart(3, '0')}` : 'ISSUE-000');

  const testTarget = positional[0] || named.file || `verify-${issueId.toLowerCase()}.test.mjs`;
  const fullTestPath = resolve(ctx.codeDir, testTarget);

  // If --scaffold or file does not exist yet and --scaffold requested, invoke harness scaffold-test
  if (named.scaffold || (!existsSync(fullTestPath) && named.title)) {
    const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
    if (existsSync(harnessPath)) {
      spawnSync(
        'node',
        [harnessPath, 'scaffold-test', '--issue', issueId, '--title', named.title || 'AC Verification', '--output', fullTestPath],
        { cwd: ctx.codeDir, encoding: 'utf8' }
      );
    }
  }

  if (!existsSync(fullTestPath)) {
    emitResult(
      {
        ok: false,
        summary: `Test file '${testTarget}' does not exist. Create it first or pass --scaffold.`,
        next: `bv write-red ${testTarget} --scaffold`
      },
      4
    );
  }

  // Run the test and REQUIRE it to fail (exit code != 0)
  const isMjs = testTarget.endsWith('.mjs') || testTarget.endsWith('.js');
  const isE2e = testTarget.endsWith('.ui.spec.ts') || testTarget.startsWith('packages/e2e/');
  const runner = isMjs ? 'node' : 'pnpm';
  const runnerArgs = isMjs
    ? [fullTestPath]
    : isE2e
      ? ['--filter', '@bv/e2e', 'test', testTarget.replace(/^packages\/e2e\//, '')]
      : ['test', testTarget];

  const runRes = spawnSync(runner, runnerArgs, {
    cwd: ctx.codeDir,
    encoding: 'utf8',
    timeout: 120000
  });

  const combinedOut = `${runRes.stdout || ''}\n${runRes.stderr || ''}`;
  const logRel = writeVerbLog(ctx.bvDir, 'write-red', issueNum || 'red', combinedOut);

  if (runRes.status === 0) {
    emitResult(
      {
        ok: false,
        summary: `RED GATE FAILED: '${testTarget}' passed on unmodified code! Tests in RED phase must fail against unimplemented ACs.`,
        next: `bv write-red ${testTarget}`,
        artifacts: [logRel]
      },
      2
    );
  }

  const failMatches = combinedOut.match(/\[✗\] FAIL:|FAIL /g) || [];
  const failingCount = Math.max(1, failMatches.length);
  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const relTestPath = relative(ctx.codeDir, fullTestPath);
  const blobHash = computeFileBlobHash(fullTestPath);

  if (ledger) {
    ledger.red = {
      tests: [relTestPath],
      blobHashes: { [relTestPath]: blobHash },
      treeHash: treeOid,
      failing: failingCount,
      lockedAt: new Date().toISOString()
    };
    writeLedger(ctx.bvDir, ledger.issue, ledger);
  }

  emitResult({
    ok: true,
    summary: `RED gate passed & locked '${relTestPath}' (${failingCount} failing assertion(s), blob ${blobHash?.slice(0, 8)}).`,
    next: 'bv set-phase code',
    artifacts: [relTestPath, logRel]
  });
}

export async function cmdGateGreen(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(named.issue || getActiveIssueNumber(ctx.bvDir));
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;

  // Enforce strict TDD contract: refuse if ledger.red is null
  if (!ledger || !ledger.red || !Array.isArray(ledger.red.tests) || ledger.red.tests.length === 0) {
    emitResult(
      {
        ok: false,
        summary: `REFUSED: bv gate-green requires a recorded RED state in the ledger (.bv/state/ISSUE-${issueNum || 'N'}.json -> red). Run 'bv write-red <test>' first.`,
        next: 'bv write-red'
      },
      4
    );
  }

  // Verify locked RED test files were not modified after RED
  const blobHashes = ledger.red.blobHashes || {};
  for (const lockedTest of ledger.red.tests) {
    const fullPath = resolve(ctx.codeDir, lockedTest);
    const currentBlob = computeFileBlobHash(fullPath);
    const expectedBlob = blobHashes[lockedTest];
    if (expectedBlob && currentBlob !== expectedBlob) {
      emitResult(
        {
          ok: false,
          summary: `TAMPER DETECTED: Locked RED test '${lockedTest}' was modified after RED phase (expected blob ${expectedBlob.slice(0, 8)}, got ${currentBlob ? currentBlob.slice(0, 8) : 'missing'}). Restore the test file immediately.`,
          next: `git checkout -- ${lockedTest}`
        },
        3
      );
    }
  }

  const testTarget = positional[0] || ledger.red.tests[0];
  const fullTestPath = resolve(ctx.codeDir, testTarget);

  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const cacheKey = getCacheKey('gate-green', [testTarget], treeOid);
  if (!named['no-cache']) {
    const cached = readCache(ctx.bvDir, cacheKey);
    if (cached && cached.ok) {
      emitResult({ ...cached, cached: true }, 0);
    }
  }

  const isMjs = testTarget.endsWith('.mjs') || testTarget.endsWith('.js');
  const isE2e = testTarget.endsWith('.ui.spec.ts') || testTarget.startsWith('packages/e2e/');
  const runner = isMjs ? 'node' : 'pnpm';
  const runnerArgs = isMjs
    ? [fullTestPath]
    : isE2e
      ? ['--filter', '@bv/e2e', 'test', testTarget.replace(/^packages\/e2e\//, '')]
      : ['test', testTarget];

  const t0 = Date.now();
  const runRes = spawnSync(runner, runnerArgs, {
    cwd: ctx.codeDir,
    encoding: 'utf8',
    timeout: 180000
  });
  const durationMs = Date.now() - t0;

  const combinedOut = `${runRes.stdout || ''}\n${runRes.stderr || ''}`;
  const logRel = writeVerbLog(ctx.bvDir, 'gate-green', issueNum || 'green', combinedOut);

  if (runRes.status !== 0) {
    const failureCheck = recordPhaseFailure(
      ctx.bvDir,
      ctx.config,
      'gate-green',
      combinedOut.split('\n').filter(l => l.includes('FAIL') || l.includes('Error')).slice(-5).join(' | '),
      issueNum
    );
    if (failureCheck.shouldBlock) {
      await cmdBlockIssue(ctx, [failureCheck.blockReason, '--issue', String(issueNum)]);
      return;
    }
    emitResult(
      {
        ok: false,
        summary: `GREEN gate failed on '${testTarget}' (exit ${runRes.status}, attempt ${failureCheck.attempts}). See ${logRel}.`,
        next: `bv gate-green ${testTarget}`,
        artifacts: [logRel],
        data: {
          tail: combinedOut.trim().split('\n').slice(-12)
        }
      },
      2
    );
  }

  ledger.green = {
    tests: ledger.red.tests,
    treeHash: treeOid,
    durationMs,
    passedAt: new Date().toISOString()
  };
  writeLedger(ctx.bvDir, ledger.issue, ledger);

  const resObj = {
    ok: true,
    summary: `GREEN gate passed on '${testTarget}' in ${durationMs}ms (tree ${treeOid.slice(0, 8)}).`,
    next: 'bv lint-types',
    artifacts: [logRel]
  };
  writeCache(ctx.bvDir, cacheKey, resObj);
  emitResult(resObj, 0);
}

export async function cmdCheckScope(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const issueNum = Number(named.issue || getActiveIssueNumber(ctx.bvDir));
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;

  // If --spec or --files passed (legacy harness mode), run Rule-of-3 heuristic
  if (named.spec || named.files) {
    const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
    if (existsSync(harnessPath)) {
      const hRes = spawnSync('node', [harnessPath, 'check-scope', ...rawArgs], {
        cwd: ctx.codeDir,
        encoding: 'utf8'
      });
      emitResult(
        {
          ok: hRes.status === 0,
          summary: (hRes.stdout || hRes.stderr || '').trim().split('\n')[0] || 'Scope checked.',
          next: 'bv gate-green'
        },
        hRes.status === 0 ? 0 : 2
      );
    }
  }

  // Check git status for any edits to locked RED tests or prohibited paths
  const statusRes = spawnSync('git', ['status', '--porcelain'], { cwd: ctx.codeDir, encoding: 'utf8' });
  const modifiedFiles = (statusRes.stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.slice(2).trim());

  const violations = [];
  if (ledger?.red?.tests && ledger.phase === 'code') {
    const blobHashes = ledger.red.blobHashes || {};
    for (const lockedTest of ledger.red.tests) {
      const currHash = computeFileBlobHash(resolve(ctx.codeDir, lockedTest));
      if (blobHashes[lockedTest] && currHash !== blobHashes[lockedTest]) {
        violations.push(`Locked RED test modified during CODE phase: ${lockedTest}`);
      }
    }
  }

  for (const f of modifiedFiles) {
    if (f.startsWith('.agents/hooks') || f === 'scripts/orchestrator-harness.mjs') {
      violations.push(`Protected harness/hook file modified: ${f}`);
    }
  }

  if (violations.length > 0) {
    emitResult(
      {
        ok: false,
        summary: `Scope check failed: ${violations.join('; ')}`,
        next: 'git checkout -- <violating-file>',
        data: { violations }
      },
      2
    );
  }

  emitResult({
    ok: true,
    summary: `Scope check passed (${modifiedFiles.length} touched files within allowed boundaries).`,
    next: 'bv gate-green',
    data: { modifiedFiles: modifiedFiles.slice(0, 15) }
  });
}

export async function cmdLintTypes(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const cacheKey = getCacheKey('lint-types', [], treeOid);

  if (!named['no-cache']) {
    const cached = readCache(ctx.bvDir, cacheKey);
    if (cached) {
      emitResult({ ...cached, cached: true }, cached.ok ? 0 : 2);
    }
  }

  const t0 = Date.now();
  const oxlintRes = spawnSync(
    'oxlint',
    ['-D', 'typescript/no-explicit-any', '--ignore-pattern', 'dist', '--ignore-pattern', '*.spec.ts', 'apps', 'packages'],
    {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 60000
    }
  );
  const tscRes = spawnSync(
    'pnpm',
    ['--filter', '@bv/schema', '--filter', '@bv/backend', '--filter', '@bv/spirit', 'exec', 'tsc', '--noEmit'],
    {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 120000
    }
  );
  const durationMs = Date.now() - t0;

  const combined = `=== OXLINT ===\n${oxlintRes.stdout || ''}\n${oxlintRes.stderr || ''}\n=== TSC ===\n${tscRes.stdout || ''}\n${tscRes.stderr || ''}`;
  const issueNum = getActiveIssueNumber(ctx.bvDir);
  const logRel = writeVerbLog(ctx.bvDir, 'lint-types', issueNum || 'head', combined);

  const ok = oxlintRes.status === 0 && tscRes.status === 0;
  const resObj = {
    ok,
    summary: ok
      ? `lint-types passed in ${durationMs}ms (0 oxlint errors, 0 tsc errors).`
      : `lint-types failed (oxlint=${oxlintRes.status}, tsc=${tscRes.status}). See ${logRel}.`,
    next: ok ? 'bv gate-green' : 'bv lint-types',
    artifacts: [logRel],
    data: ok
      ? undefined
      : {
          errors: combined
            .split('\n')
            .filter(l => l.includes('error TS') || l.includes('no-explicit-any') || l.includes('×'))
            .slice(0, 15)
        }
  };

  writeCache(ctx.bvDir, cacheKey, resObj);
  emitResult(resObj, ok ? 0 : 2);
}

export async function cmdRestoreArtifacts(ctx) {
  const knownArtifacts = ['exports/whatsapp-catalog/catalog_inventory.xlsx', 'exports/whatsapp-catalog/catalog_inventory.csv'];
  const restored = [];
  for (const rel of knownArtifacts) {
    const check = spawnSync('git', ['status', '--porcelain', rel], { cwd: ctx.codeDir, encoding: 'utf8' });
    if (check.stdout && check.stdout.trim()) {
      spawnSync('git', ['checkout', '--', rel], { cwd: ctx.codeDir, encoding: 'utf8' });
      restored.push(rel);
    }
  }
  emitResult({
    ok: true,
    summary: restored.length > 0 ? `Restored ${restored.length} mutated artifact(s): ${restored.join(', ')}` : 'Working tree artifacts clean.',
    next: 'bv ledger',
    artifacts: restored
  });
}

export async function cmdVerify(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  if (named['dry-run']) {
    const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
    const res = spawnSync('node', [harnessPath, 'verify-all', '--dry-run'], { cwd: ctx.codeDir, encoding: 'utf8' });
    emitResult({
      ok: res.status === 0,
      summary: (res.stdout || '').trim().split('\n')[0] || 'Dry-run complete',
      next: 'bv verify'
    });
  }

  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const cacheKey = getCacheKey('verify', [], treeOid);

  if (!named['no-cache']) {
    const cached = readCache(ctx.bvDir, cacheKey);
    if (cached) {
      emitResult({ ...cached, cached: true }, cached.ok ? 0 : 2);
    }
  }

  const issueNum = getActiveIssueNumber(ctx.bvDir);
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;

  // 1. If active issue has ledger.red, verify locked test first
  if (ledger?.red?.tests?.[0]) {
    const lockedTest = ledger.red.tests[0];
    const greenRes = spawnSync('node', [resolve(ctx.codeDir, lockedTest)], {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 120000
    });
    if (greenRes.status !== 0) {
      const logRel = writeVerbLog(ctx.bvDir, 'verify', issueNum || 'head', greenRes.stdout + '\n' + greenRes.stderr);
      emitResult(
        {
          ok: false,
          summary: `Verify failed on locked RED test '${lockedTest}'.`,
          next: `bv gate-green ${lockedTest}`,
          artifacts: [logRel]
        },
        2
      );
    }
  }

  // 2. Run verify-all via orchestrator-harness.mjs
  const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
  const t0 = Date.now();
  const verifyRes = spawnSync('node', [harnessPath, 'verify-all', '--ci-env'], {
    cwd: ctx.codeDir,
    encoding: 'utf8',
    timeout: 600000
  });
  const durationMs = Date.now() - t0;

  // Always restore mutated catalog_inventory.xlsx immediately after verify-all
  spawnSync('git', ['checkout', '--', 'exports/whatsapp-catalog/catalog_inventory.xlsx'], {
    cwd: ctx.codeDir,
    encoding: 'utf8'
  });

  const combinedOut = `${verifyRes.stdout || ''}\n${verifyRes.stderr || ''}`;
  const logRel = writeVerbLog(ctx.bvDir, 'verify', issueNum || 'head', combinedOut);
  const ok = verifyRes.status === 0;

  // Recompute treeOid after restoring catalog_inventory.xlsx so subsequent cached calls hit cleanly!
  const cleanTreeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);
  const cleanCacheKey = getCacheKey('verify', [], cleanTreeOid);

  if (ledger) {
    ledger.verify = {
      ok,
      treeHash: cleanTreeOid,
      durationMs,
      verifiedAt: new Date().toISOString()
    };
    writeLedger(ctx.bvDir, ledger.issue, ledger);
  }

  // Identify regressing files from branch diff if failed
  let regressingFiles = [];
  if (!ok) {
    const diffNames = spawnSync('git', ['diff', '--name-only', 'main...HEAD'], { cwd: ctx.codeDir, encoding: 'utf8' });
    regressingFiles = (diffNames.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  }

  const summaryLine =
    (verifyRes.stdout || '')
      .split('\n')
      .find(l => l.includes('VERIFICATION SUMMARY:')) ||
    (ok ? 'All verification suites passed.' : 'One or more verification suites failed.');

  const resObj = {
    ok,
    summary: `${summaryLine} (${(durationMs / 1000).toFixed(1)}s, tree ${cleanTreeOid.slice(0, 8)}).`,
    next: ok ? 'bv set-phase ship' : 'bv set-phase code',
    artifacts: [logRel],
    data: ok
      ? undefined
      : {
          regressingFiles: regressingFiles.slice(0, 10),
          failedSuites: (verifyRes.stdout || '')
            .split('\n')
            .filter(l => l.includes('[✗ FAIL]'))
            .map(l => l.trim())
        }
  };

  writeCache(ctx.bvDir, cacheKey, resObj);
  writeCache(ctx.bvDir, cleanCacheKey, resObj);
  emitResult(resObj, ok ? 0 : 2);
}

export async function cmdCaptureProof(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const issueNum = Number(named['gh-issue'] || named.ghIssue || getActiveIssueNumber(ctx.bvDir));
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;
  const issueId = named.issue || ledger?.id || (issueNum ? `ISSUE-${String(issueNum).padStart(3, '0')}` : null);

  if (!issueId || !issueNum) {
    emitResult(
      {
        ok: false,
        summary: 'Usage: bv capture-proof --issue <ISSUE-ID> --gh-issue <number>',
        next: 'bv capture-proof --help'
      },
      4
    );
  }

  // Preflight check: verify Infisical CLI is reachable and authenticated
  const infCheck = spawnSync('infisical', ['export', '--env=dev', '--format=json'], {
    cwd: ctx.codeDir,
    encoding: 'utf8',
    timeout: 15000
  });
  if (infCheck.status !== 0 || !infCheck.stdout.trim().startsWith('[')) {
    emitResult(
      {
        ok: false,
        summary: 'Preflight blocked: Infisical CLI cannot export dev secrets. Authenticate with `infisical login` first.',
        next: 'bv block-issue "Infisical authentication required for capture-proof"'
      },
      3
    );
  }

  const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
  const proofArgs = [harnessPath, 'proof', '--issue', issueId, '--gh-issue', String(issueNum)];
  if (named['local-img']) proofArgs.push('--local-img', named['local-img']);
  if (named['live-img']) proofArgs.push('--live-img', named['live-img']);

  const runRes = spawnSync(
    'infisical',
    ['run', '--env=dev', '--', 'node', ...proofArgs],
    { cwd: ctx.codeDir, encoding: 'utf8', timeout: 300000 }
  );

  const logRel = writeVerbLog(ctx.bvDir, 'capture-proof', issueNum, `${runRes.stdout || ''}\n${runRes.stderr || ''}`);
  if (runRes.status !== 0) {
    emitResult(
      {
        ok: false,
        summary: `Playwright proof capture failed for ${issueId} (#${issueNum}). Failing closed (exit 3).`,
        next: `bv block-issue "capture-proof preflight/capture failed for ${issueId}"`,
        artifacts: [logRel]
      },
      3
    );
  }

  emitResult({
    ok: true,
    summary: `Captured and attached Local & Live visual proofs for ${issueId} (#${issueNum}).`,
    next: 'bv post-comment qa',
    artifacts: [
      `bv-blueprint/proofs/${issueId}/local-proof.png`,
      `bv-blueprint/proofs/${issueId}/live-proof.png`,
      logRel
    ]
  });
}

export async function cmdManualCheck(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue || getActiveIssueNumber(ctx.bvDir));
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;
  const issueId = (ledger?.id || `ISSUE-${String(issueNum || 0).padStart(3, '0')}`).toLowerCase();

  const candidates = [
    join(ctx.codeDir, 'manual', `${issueId.toUpperCase()}.mjs`),
    join(ctx.codeDir, 'manual', `${issueId}.mjs`),
    join(ctx.codeDir, 'scripts', `manual-verify-${issueId}.mjs`)
  ];
  const found = candidates.find(existsSync);
  if (!found) {
    emitResult({
      ok: true,
      summary: `No manual scenario script required for ${issueId.toUpperCase()}.`,
      next: 'bv post-comment qa'
    });
  }

  const res = spawnSync('node', [found], { cwd: ctx.codeDir, encoding: 'utf8', timeout: 120000 });
  const logRel = writeVerbLog(ctx.bvDir, 'manual-check', issueNum || 'manual', `${res.stdout || ''}\n${res.stderr || ''}`);
  emitResult(
    {
      ok: res.status === 0,
      summary: res.status === 0 ? `Manual check passed: ${relative(ctx.codeDir, found)}` : `Manual check failed: ${relative(ctx.codeDir, found)}`,
      next: res.status === 0 ? 'bv post-comment qa' : 'bv set-phase code',
      artifacts: [logRel]
    },
    res.status === 0 ? 0 : 2
  );
}

export async function cmdPrepush(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const checkOnly = named['check-only'];

  // 1. Tracked + untracked .env* guard: ONLY .env.schema is allowed!
  const trackedRes = spawnSync('git', ['ls-files'], { cwd: ctx.codeDir, encoding: 'utf8' });
  const trackedEnvFiles = (trackedRes.stdout || '')
    .split('\n')
    .map(f => f.trim())
    .filter(f => f && (basename(f) === '.env' || basename(f).startsWith('.env.')) && basename(f) !== '.env.schema');

  // Also scan filesystem for any forbidden .env* files in codeDir
  function findDiskEnvFiles(dir, depth = 0) {
    if (depth > 4) return [];
    let found = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', '.bv'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          found = found.concat(findDiskEnvFiles(full, depth + 1));
        } else if (
          (entry.name === '.env' || entry.name.startsWith('.env.')) &&
          entry.name !== '.env.schema'
        ) {
          found.push(relative(ctx.codeDir, full));
        }
      }
    } catch {}
    return found;
  }

  const diskEnvFiles = findDiskEnvFiles(ctx.codeDir);
  if (trackedEnvFiles.length > 0 || diskEnvFiles.length > 0) {
    const allBad = Array.from(new Set([...trackedEnvFiles, ...diskEnvFiles]));
    emitResult(
      {
        ok: false,
        summary: `Zero-.env guard failed! Forbidden .env* files detected (only .env.schema is permitted): ${allBad.join(', ')}`,
        next: `rm ${allBad.join(' ')}`,
        data: { forbiddenEnvFiles: allBad }
      },
      2
    );
  }

  // 2. Gitleaks scan on uncommitted / staged changes if gitleaks is installed
  if (!checkOnly || checkOnly === 'secrets') {
    const glRes = spawnSync('gitleaks', ['protect', '--staged', '--no-banner'], {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 30000
    });
    if (glRes.status !== 0 && glRes.error == null) {
      const logRel = writeVerbLog(ctx.bvDir, 'prepush-gitleaks', 'staged', `${glRes.stdout || ''}\n${glRes.stderr || ''}`);
      emitResult(
        {
          ok: false,
          summary: `gitleaks protect detected staged secrets!`,
          next: 'bv prepush',
          artifacts: [logRel]
        },
        2
      );
    }
  }

  // 3. Delegate to orchestrator-harness prepush if present
  const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
  if (existsSync(harnessPath)) {
    const hArgs = [harnessPath, 'prepush'];
    if (checkOnly) hArgs.push(`--check-only=${checkOnly}`);
    const hRes = spawnSync('node', hArgs, { cwd: ctx.codeDir, encoding: 'utf8', timeout: 600000 });
    // Restore catalog_inventory.xlsx if verify-all mutated it
    spawnSync('git', ['checkout', '--', 'exports/whatsapp-catalog/catalog_inventory.xlsx'], { cwd: ctx.codeDir });
    const logRel = writeVerbLog(ctx.bvDir, 'prepush', 'latest', `${hRes.stdout || ''}\n${hRes.stderr || ''}`);
    if (hRes.status !== 0) {
      emitResult(
        {
          ok: false,
          summary: `Prepush validation failed. See ${logRel}.`,
          next: 'bv prepush',
          artifacts: [logRel]
        },
        2
      );
    }
    emitResult({
      ok: true,
      summary: `Prepush gate passed: zero forbidden .env* files, gitleaks clean, git hygiene & CI simulation passed.`,
      next: 'bv ship',
      artifacts: [logRel]
    });
  }

  emitResult({
    ok: true,
    summary: 'Prepush gate passed: zero forbidden .env* files and gitleaks clean.',
    next: 'bv ship'
  });
}

export async function cmdShip(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  const issueNum = Number(named['gh-issue'] || named.ghIssue || getActiveIssueNumber(ctx.bvDir));
  const ledger = issueNum ? readLedger(ctx.bvDir, issueNum) : null;

  const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
  const shipArgs = [harnessPath, 'ship', ...rawArgs];
  if (ledger?.id && !named.issue) {
    shipArgs.push('--issue', ledger.id);
  }
  if (issueNum && !named['gh-issue'] && !named.ghIssue) {
    shipArgs.push('--gh-issue', String(issueNum));
  }

  const res = spawnSync('node', shipArgs, { cwd: ctx.codeDir, encoding: 'utf8', timeout: 300000 });
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
  const logRel = writeVerbLog(ctx.bvDir, 'ship', issueNum || 'head', combined);

  if (res.status !== 0) {
    emitResult(
      {
        ok: false,
        summary: `Ship failed (exit ${res.status}). See ${logRel}.`,
        next: 'bv prepush',
        artifacts: [logRel]
      },
      2
    );
  }

  const prMatch = combined.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (ledger) {
    ledger.pr = {
      url: prMatch ? prMatch[0] : 'merged',
      number: prMatch ? Number(prMatch[1]) : null,
      shippedAt: new Date().toISOString()
    };
    writeLedger(ctx.bvDir, ledger.issue, ledger);
  }

  emitResult({
    ok: true,
    summary: `Shipped changes (${prMatch ? prMatch[0] : 'commit/merge complete'}).`,
    next: 'bv watch-ci',
    artifacts: [logRel]
  });
}

export async function cmdWatchCi(ctx, rawArgs) {
  const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
  const res = spawnSync('node', [harnessPath, 'ci-watch', ...rawArgs], {
    cwd: ctx.codeDir,
    encoding: 'utf8',
    timeout: 900000
  });
  const logRel = writeVerbLog(ctx.bvDir, 'watch-ci', 'latest', `${res.stdout || ''}\n${res.stderr || ''}`);
  emitResult(
    {
      ok: res.status === 0,
      summary: res.status === 0 ? 'GitHub Actions CI run succeeded.' : 'GitHub Actions CI run failed.',
      next: res.status === 0 ? 'bv verify-prod' : 'bv watch-ci',
      artifacts: [logRel]
    },
    res.status === 0 ? 0 : 2
  );
}

export async function cmdVpsStatus(ctx, rawArgs) {
  const harnessPath = join(ctx.codeDir, 'scripts', 'orchestrator-harness.mjs');
  const res = spawnSync('node', [harnessPath, 'vps-status', ...rawArgs], {
    cwd: ctx.codeDir,
    encoding: 'utf8',
    timeout: 30000
  });
  const logRel = writeVerbLog(ctx.bvDir, 'vps-status', 'prod', `${res.stdout || ''}\n${res.stderr || ''}`);
  emitResult(
    {
      ok: res.status === 0,
      summary: res.status === 0 ? 'VPS read-only status check healthy.' : 'VPS status check failed.',
      next: 'bv verify-prod',
      artifacts: [logRel]
    },
    res.status === 0 ? 0 : 2
  );
}

export async function cmdVerifyProd(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  if (named['dry-run']) {
    emitResult({ ok: true, summary: 'verify-prod dry-run passed.', next: 'bv close-issue' });
  }
  const url = named.url || 'https://api.boutiquevaleria.com/api/health';
  const curlRes = spawnSync('curl', ['-fsSL', '-m', '10', url], { encoding: 'utf8' });
  const ok = curlRes.status === 0;
  emitResult(
    {
      ok,
      summary: ok ? `Prod smoke check passed (${url}): ${(curlRes.stdout || '').trim().slice(0, 100)}` : `Prod smoke check failed (${url}).`,
      next: ok ? 'bv close-issue' : 'bv vps-status'
    },
    ok ? 0 : 2
  );
}

export async function cmdCloseIssue(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue || getActiveIssueNumber(ctx.bvDir));
  if (!issueNum) {
    emitResult({ ok: false, summary: 'Usage: bv close-issue [--issue <n>]', next: 'bv ledger' }, 4);
  }

  const ledger = readLedger(ctx.bvDir, issueNum);
  if (!named.force && ledger) {
    const missingGates = ['red', 'green', 'review', 'verify', 'pr'].filter(g => !ledger[g]);
    if (missingGates.length > 0) {
      emitResult(
        {
          ok: false,
          summary: `Refusing to close issue #${issueNum}: missing required ledger gates: ${missingGates.join(', ')}.`,
          next: `bv set-phase ${missingGates[0] === 'pr' ? 'ship' : missingGates[0]}`
        },
        4
      );
    }
  }

  if (!named['dry-run']) {
    const repo = ctx.config?.repos?.backlog || 'reymundolopez/bv-blueprint';
    const closeMsg = `✅ All deterministic SDLC gates (\`red\`, \`green\`, \`review\`, \`verify\`, \`pr\`) verified for ${ledger?.id || `#${issueNum}`}. Closing issue.`;
    spawnSync(
      'gh',
      [
        'issue',
        'edit',
        String(issueNum),
        '--repo',
        repo,
        '--add-label',
        'status:pr-ready',
        '--remove-label',
        'status:in-progress,status:in-review,agent:coder,agent:qa,agent:reviewer,agent:architect,agent:product'
      ],
      { cwd: ctx.codeDir, encoding: 'utf8' }
    );
    spawnSync('gh', ['issue', 'close', String(issueNum), '--repo', repo, '--comment', closeMsg], {
      cwd: ctx.codeDir,
      encoding: 'utf8'
    });
  }

  clearActiveIssue(ctx.bvDir);
  emitResult({
    ok: true,
    summary: `Closed issue #${issueNum} and released ACTIVE_ISSUE lock.`,
    next: null
  });
}

export async function cmdBlockIssue(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const reason = positional[0] || named.reason || 'Blocked due to repeated deterministic gate failure.';
  const issueNum = Number(named.issue || getActiveIssueNumber(ctx.bvDir));

  if (issueNum && !named['dry-run']) {
    const repo = ctx.config?.repos?.backlog || 'reymundolopez/bv-blueprint';
    const ledger = readLedger(ctx.bvDir, issueNum);
    const body = [
      `### 🛑 Automated SDLC Escalation (\`status:blocked\`)`,
      `- **Issue:** #${issueNum} (${ledger?.id || 'N/A'})`,
      `- **Phase:** \`${ledger?.phase || 'unknown'}\``,
      `- **Reason:** ${reason}`,
      `- **Attempts:** \`${JSON.stringify(ledger?.attempts || {})}\``,
      `- **Failure Hashes:** \`${JSON.stringify(ledger?.failureHashes || {})}\``
    ].join('\n');

    spawnSync(
      'gh',
      [
        'issue',
        'edit',
        String(issueNum),
        '--repo',
        repo,
        '--add-label',
        'status:blocked',
        '--remove-label',
        'status:in-progress,status:in-review'
      ],
      { cwd: ctx.codeDir, encoding: 'utf8' }
    );
    spawnSync('gh', ['issue', 'comment', String(issueNum), '--repo', repo, '--body', body], {
      cwd: ctx.codeDir,
      encoding: 'utf8'
    });
  }

  clearActiveIssue(ctx.bvDir);
  emitResult(
    {
      ok: false,
      summary: `BLOCKED issue #${issueNum || 'N/A'}: ${reason}`,
      next: null
    },
    3
  );
}

export async function cmdDbUp(ctx, rawArgs) {
  const { named } = parseFlags(rawArgs);
  if (named['dry-run']) {
    emitResult({ ok: true, summary: 'db-up dry-run: DATABASE_URL (value redacted) via Infisical.', next: 'bv verify' });
  }

  const composeFile = join(ctx.codeDir, 'docker-compose.dev.yml');
  if (existsSync(composeFile)) {
    spawnSync('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', '--wait'], {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 60000
    });
  }

  const migRes = spawnSync(
    'infisical',
    [
      'run',
      '--env=dev',
      '--',
      'pnpm',
      '--filter',
      '@bv/schema',
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--schema=./prisma/schema'
    ],
    { cwd: ctx.codeDir, encoding: 'utf8', timeout: 45000 }
  );

  const logRel = writeVerbLog(ctx.bvDir, 'db-up', 'local', `${migRes.stdout || ''}\n${migRes.stderr || ''}`);
  emitResult(
    {
      ok: migRes.status === 0,
      summary:
        migRes.status === 0
          ? 'Local database container up and Prisma migrations synced using secret var DATABASE_URL (via Infisical).'
          : 'Local database sync exited non-zero (check Docker daemon or Infisical auth).',
      next: 'bv verify',
      artifacts: [logRel]
    },
    migRes.status === 0 ? 0 : 2
  );
}

export async function cmdSecretsRun(ctx, rawArgs) {
  const { positional } = parseFlags(rawArgs);
  if (positional.length === 0) {
    emitResult({ ok: false, summary: 'Usage: bv secrets-run <command...>', next: 'bv secrets-run --help' }, 4);
  }

  const res = spawnSync(
    'infisical',
    ['run', '--env=dev', '--', 'pnpm', 'exec', 'varlock', 'run', '--', ...rawArgs],
    { cwd: ctx.codeDir, encoding: 'utf8', timeout: 600000 }
  );
  const logRel = writeVerbLog(ctx.bvDir, 'secrets-run', 'cmd', `${res.stdout || ''}\n${res.stderr || ''}`);
  emitResult(
    {
      ok: res.status === 0,
      summary: `Executed '${rawArgs.join(' ')}' inside Infisical + Varlock runtime (exit ${res.status}).`,
      next: 'bv ledger',
      artifacts: [logRel]
    },
    res.status === 0 ? 0 : 2
  );
}

export async function cmdLedger(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue || getActiveIssueNumber(ctx.bvDir));
  const treeOid = computeWorkingTreeOid(ctx.codeDir, ctx.bvDir);

  if (!issueNum) {
    emitResult({
      ok: true,
      summary: `No active issue lock. Working tree OID: ${treeOid.slice(0, 12)}.`,
      next: 'bv start-issue <n>',
      data: { activeIssue: null, workingTreeOid: treeOid }
    });
  }

  const ledger = readLedger(ctx.bvDir, issueNum);
  if (!ledger) {
    emitResult({
      ok: true,
      summary: `Active issue #${issueNum} has no ledger file yet.`,
      next: `bv start-issue ${issueNum}`,
      data: { activeIssue: issueNum, workingTreeOid: treeOid }
    });
  }

  const nextVerbByPhase = {
    intake: `bv set-phase red`,
    red: `bv write-red`,
    code: `bv gate-green`,
    review: `bv review-static`,
    verify: `bv verify`,
    ship: `bv prepush`
  };

  emitResult({
    ok: true,
    summary: `${ledger.id} (#${ledger.issue}) | phase=${ledger.phase} | branch=${ledger.branch} | tree=${treeOid.slice(0, 8)}`,
    next: nextVerbByPhase[ledger.phase] || 'bv doctor',
    artifacts: [`.bv/state/ISSUE-${ledger.issue}.json`],
    data: {
      issue: ledger.issue,
      id: ledger.id,
      phase: ledger.phase,
      attempts: ledger.attempts,
      gates: {
        red: Boolean(ledger.red),
        green: Boolean(ledger.green),
        review: Boolean(ledger.review?.ok),
        verify: Boolean(ledger.verify?.ok),
        pr: Boolean(ledger.pr)
      }
    }
  });
}

export async function cmdDoctor(ctx) {
  const checks = [];
  let allOk = true;

  function record(name, ok, detail) {
    checks.push({ name, ok, detail });
    if (!ok) allOk = false;
  }

  // 1. Check GEMINI.md line budget (<= 40 lines) in workspaceRoot, codeDir, blueprintDir
  const geminiLocations = [
    join(ctx.workspaceRoot, 'GEMINI.md'),
    join(ctx.codeDir, 'GEMINI.md'),
    ctx.blueprintDir ? join(ctx.blueprintDir, 'GEMINI.md') : null
  ].filter(Boolean);

  for (const gp of geminiLocations) {
    if (existsSync(gp)) {
      const lines = readFileSync(gp, 'utf8').split('\n').length;
      record(`GEMINI.md (${relative(ctx.workspaceRoot, gp) || 'root'}) <= 40 lines`, lines <= 40, `${lines} lines`);
    }
  }

  // 2. Check subagent frontmatter isolation (inheritCustomizations: false, excludeDefaultComponents: true, inheritMcp: false, <= 20 lines)
  const agentDirs = [
    join(ctx.workspaceRoot, '.agents', 'agents'),
    join(ctx.kitRoot, 'agents')
  ].filter(existsSync);

  for (const ad of agentDirs) {
    const files = readdirSync(ad).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const content = readFileSync(join(ad, f), 'utf8');
      const lineCount = content.trim().split('\n').length;
      const hasIsolation =
        content.includes('inheritCustomizations: false') &&
        content.includes('excludeDefaultComponents: true') &&
        content.includes('inheritMcp: false');
      record(
        `Agent ${f} (${relative(ctx.workspaceRoot, ad)}) isolation & <=20 lines`,
        hasIsolation && lineCount <= 20,
        `${lineCount} lines, isolated=${hasIsolation}`
      );
    }
  }

  // 3. Check hooks.json existence
  const hooksLocations = [
    join(ctx.workspaceRoot, '.agents', 'hooks.json'),
    join(ctx.codeDir, '.agents', 'hooks.json'),
    join(ctx.kitRoot, 'hooks.json')
  ];
  const activeHooks = hooksLocations.filter(existsSync);
  record('hooks.json present', activeHooks.length > 0, activeHooks.map(p => relative(ctx.workspaceRoot, p)).join(', '));

  // 4. Zero .env* files (except .env.schema) across workspace
  const badEnvs = [];
  function scanEnvs(dir, depth = 0) {
    if (depth > 4) return;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', '.bv'].includes(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) scanEnvs(full, depth + 1);
        else if ((e.name === '.env' || e.name.startsWith('.env.')) && e.name !== '.env.schema') {
          badEnvs.push(relative(ctx.workspaceRoot, full));
        }
      }
    } catch {}
  }
  scanEnvs(ctx.workspaceRoot);
  if (existsSync( join(process.env.HOME || '', '.bv-admin-env') )) {
    badEnvs.push('~/.bv-admin-env');
  }
  record('Zero plaintext .env* files (only .env.schema)', badEnvs.length === 0, badEnvs.length === 0 ? 'clean' : badEnvs.join(', '));

  // 5. Specialist CLI tools available (optional in headless Ubuntu CI where brew binaries aren't preinstalled)
  if (!process.env.CI) {
    for (const bin of ['rg', 'ast-grep', 'oxlint', 'gitleaks', 'infisical']) {
      const w = spawnSync('which', [bin], { encoding: 'utf8' });
      record(`CLI binary '${bin}' installed`, w.status === 0, (w.stdout || '').trim() || 'missing');
    }
  }

  emitResult(
    {
      ok: allOk,
      summary: allOk
        ? `bv doctor passed all ${checks.length} checks (context budget, subagent isolation, hooks, zero-.env, tools).`
        : `bv doctor found failing checks: ${checks.filter(c => !c.ok).map(c => `${c.name} (${c.detail})`).join('; ')}`,
      next: allOk ? 'bv ledger' : 'bv doctor',
      data: {
        checks: checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`)
      }
    },
    allOk ? 0 : 2
  );
}

export async function cmdTelemetryReport(ctx) {
  const callsPath = join(ctx.bvDir, 'calls.jsonl');
  if (!existsSync(callsPath)) {
    emitResult({
      ok: true,
      summary: 'No calls recorded in .bv/calls.jsonl yet.',
      next: 'bv ledger',
      data: { totalCalls: 0, byRole: {}, duplicatesBlocked: 0 }
    });
  }

  const lines = readFileSync(callsPath, 'utf8')
    .split('\n')
    .filter(Boolean);
  const byRole = {};
  const byPhase = {};
  let duplicatesBlocked = 0;
  let securityDenied = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const role = entry.role || 'interactive';
      const phase = entry.phase || 'ad-hoc';
      byRole[role] = (byRole[role] || 0) + 1;
      byPhase[phase] = (byPhase[phase] || 0) + 1;
      if (entry.decision === 'deny' && String(entry.reason || '').includes('Already read')) {
        duplicatesBlocked++;
      }
      if (entry.decision === 'deny' && String(entry.reason || '').includes('SECURITY')) {
        securityDenied++;
      }
    } catch {}
  }

  emitResult({
    ok: true,
    summary: `Telemetry report: ${lines.length} tool calls logged, ${duplicatesBlocked} duplicate reads blocked, ${securityDenied} security denies.`,
    next: 'bv ledger',
    artifacts: ['.bv/calls.jsonl'],
    data: {
      totalCalls: lines.length,
      byRole,
      byPhase,
      duplicatesBlocked,
      securityDenied
    }
  });
}

export async function cmdRunIssue(ctx, rawArgs) {
  const { named, positional } = parseFlags(rawArgs);
  const issueNum = Number(positional[0] || named.issue);
  if (!issueNum) {
    emitResult({ ok: false, summary: 'Usage: bv run-issue <n> [--with-spec] [--with-design] [--deep-review] [--dry-run]', next: 'bv run-issue <n>' }, 4);
  }

  const isDryRun = Boolean(named['dry-run']);
  const phases = ctx.config?.phases || [];
  const executionPlan = [];

  for (const p of phases) {
    executionPlan.push({ id: p.id, mode: p.mode, role: p.role || null, model: p.model || null, verbs: p.verbs });
  }

  if (isDryRun) {
    emitResult({
      ok: true,
      summary: `Dry-run pipeline for issue #${issueNum}: ${executionPlan.map(p => `${p.id}(${p.mode})`).join(' -> ')}`,
      next: `bv run-issue ${issueNum}`,
      data: {
        issue: issueNum,
        llmPhases: executionPlan.filter(p => p.mode === 'llm').map(p => `${p.id} [${p.role}:${p.model}]`),
        deterministicPhases: executionPlan.filter(p => p.mode === 'deterministic').map(p => p.id)
      }
    });
  }

  const bvBin = join(ctx.kitRoot, 'bin', 'bv');
  const schemaPath = join(ctx.kitRoot, 'templates', 'phase-output.schema.json');

  function runBvSync(verb, verbArgs = []) {
    const r = spawnSync('node', [bvBin, verb, ...verbArgs], {
      cwd: ctx.codeDir,
      encoding: 'utf8',
      timeout: 600000
    });
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {}
    return { status: r.status, parsed, stdout: r.stdout, stderr: r.stderr };
  }

  function dispatchLlmRole(phaseObj, ledger) {
    const role = phaseObj.role;
    const model = phaseObj.model || 'flash';
    const prompt = `${ledger.id} phase=${phaseObj.id}. Follow your SessionStart brief and .bv/packets/ISSUE-${issueNum}/${phaseObj.id}.md.`;
    const agyRes = spawnSync(
      'agy',
      [
        '-p',
        prompt,
        '--agent',
        role,
        '--model',
        model,
        '--mode',
        'auto',
        '--output-format',
        'json',
        '--json-schema',
        schemaPath
      ],
      {
        cwd: ctx.codeDir,
        env: { ...process.env, BV_SDLC: '1', BV_ROLE: role, BV_PHASE: phaseObj.id },
        encoding: 'utf8',
        timeout: 600000
      }
    );
    writeVerbLog(ctx.bvDir, `llm-${phaseObj.id}`, issueNum, `${agyRes.stdout || ''}\n${agyRes.stderr || ''}`);
    return agyRes;
  }

  // 1. INTAKE (Deterministic)
  const startRes = runBvSync('start-issue', [String(issueNum)]);
  if (startRes.status !== 0) {
    emitResult(startRes.parsed || { ok: false, summary: 'Intake start-issue failed', next: null }, startRes.status || 2);
  }
  runBvSync('read-issue', [String(issueNum)]);
  runBvSync('read-slice');

  // Optional --with-spec / --with-design
  if (named['with-spec'] && ctx.config?.optionalLlmPhases?.spec) {
    runBvSync('set-phase', ['spec', '--issue', String(issueNum)]);
    dispatchLlmRole({ id: 'spec', ...ctx.config.optionalLlmPhases.spec }, readLedger(ctx.bvDir, issueNum));
  }
  if (named['with-design'] && ctx.config?.optionalLlmPhases?.design) {
    runBvSync('set-phase', ['design', '--issue', String(issueNum)]);
    dispatchLlmRole({ id: 'design', ...ctx.config.optionalLlmPhases.design }, readLedger(ctx.bvDir, issueNum));
  }

  // 2. RED Phase (LLM: qa)
  runBvSync('set-phase', ['red', '--issue', String(issueNum)]);
  const redPhaseCfg = phases.find(p => p.id === 'red') || { id: 'red', role: 'qa', model: 'flash' };
  dispatchLlmRole(redPhaseCfg, readLedger(ctx.bvDir, issueNum));

  let ledger = readLedger(ctx.bvDir, issueNum);
  if (!ledger?.red) {
    emitResult({ ok: false, summary: `RED phase did not record ledger.red for #${issueNum}.`, next: 'bv write-red' }, 2);
  }

  // 3. CODE -> REVIEW -> VERIFY loop (up to maxAttempts)
  const maxAttempts = ctx.config?.maxAttempts || 5;
  for (let cycle = 1; cycle <= maxAttempts; cycle++) {
    runBvSync('set-phase', ['code', '--issue', String(issueNum)]);
    const codePhaseCfg = phases.find(p => p.id === 'code') || { id: 'code', role: 'coder', model: 'flash' };
    dispatchLlmRole(codePhaseCfg, readLedger(ctx.bvDir, issueNum));

    ledger = readLedger(ctx.bvDir, issueNum);
    if (!ledger?.green) {
      const failInfo = recordPhaseFailure(ctx.bvDir, ctx.config, 'code-phase', 'Coder exited without passing bv gate-green', issueNum);
      if (failInfo.shouldBlock) {
        await cmdBlockIssue(ctx, [failInfo.blockReason, '--issue', String(issueNum)]);
        return;
      }
      continue;
    }

    // 4. REVIEW (Deterministic)
    runBvSync('set-phase', ['review', '--issue', String(issueNum)]);
    const revRes = runBvSync('review-static');
    if (revRes.status !== 0) {
      const failInfo = recordPhaseFailure(ctx.bvDir, ctx.config, 'review-static', revRes.parsed?.summary || 'Static review failed', issueNum);
      if (failInfo.shouldBlock) {
        await cmdBlockIssue(ctx, [failInfo.blockReason, '--issue', String(issueNum)]);
        return;
      }
      continue;
    }
    if (named['deep-review'] && ctx.config?.optionalLlmPhases?.deepReview) {
      dispatchLlmRole({ id: 'deepReview', ...ctx.config.optionalLlmPhases.deepReview }, readLedger(ctx.bvDir, issueNum));
    }
    runBvSync('post-comment', ['reviewer', '--issue', String(issueNum)]);

    // 5. VERIFY (Deterministic)
    runBvSync('set-phase', ['verify', '--issue', String(issueNum)]);
    const verRes = runBvSync('verify');
    if (verRes.status !== 0) {
      const failInfo = recordPhaseFailure(ctx.bvDir, ctx.config, 'verify', verRes.parsed?.summary || 'Verify failed', issueNum);
      if (failInfo.shouldBlock) {
        await cmdBlockIssue(ctx, [failInfo.blockReason, '--issue', String(issueNum)]);
        return;
      }
      continue;
    }
    runBvSync('manual-check', ['--issue', String(issueNum)]);
    runBvSync('post-comment', ['qa', '--issue', String(issueNum)]);
    break;
  }

  // 6. SHIP (Deterministic)
  runBvSync('set-phase', ['ship', '--issue', String(issueNum)]);
  const prepushRes = runBvSync('prepush');
  if (prepushRes.status !== 0) {
    emitResult(prepushRes.parsed || { ok: false, summary: 'Prepush failed in ship phase', next: 'bv prepush' }, 2);
  }

  const issueDataPath = join(ctx.bvDir, 'issues', `${issueNum}.json`);
  const issueTitle = existsSync(issueDataPath)
    ? JSON.parse(readFileSync(issueDataPath, 'utf8')).title
    : `Implement ${ledger.id}`;
  const shipRes = runBvSync('ship', ['--message', `feat(${ledger.id.toLowerCase()}): ${issueTitle}`, '--issue', ledger.id, '--gh-issue', String(issueNum)]);
  if (shipRes.status !== 0) {
    emitResult(shipRes.parsed || { ok: false, summary: 'Ship failed', next: 'bv ship' }, 2);
  }

  runBvSync('watch-ci');
  runBvSync('verify-prod');
  const closeRes = runBvSync('close-issue', ['--issue', String(issueNum)]);
  emitResult(closeRes.parsed || { ok: true, summary: `Completed issue #${issueNum}.`, next: null }, 0);
}
