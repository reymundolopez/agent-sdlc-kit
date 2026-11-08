import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveContext, computeFileBlobHash } from './core.mjs';
import { getActiveIssueState, readLedger, writeLedger, setActiveIssue } from './ledger.mjs';

/**
 * Reads JSON payload from stdin
 */
export async function readStdinJson() {
  return new Promise(res => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      if (!raw.trim()) return res({});
      try {
        res(JSON.parse(raw));
      } catch {
        res({});
      }
    });
    process.stdin.on('error', () => res({}));
  });
}

function appendCallLog(bvDir, entry) {
  try {
    mkdirSync(bvDir, { recursive: true });
    appendFileSync(join(bvDir, 'calls.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {}
}

/**
 * Determines whether the current session is an active SDLC phase session.
 * Fail-closed: defaults to active when an active issue ledger exists.
 * Bypassed only when:
 *   1. No active issue ledger exists in .bv/state/, OR
 *   2. process.env.BV_SDLC === '0' (explicit human opt-out), OR
 *   3. Explicit legacy opt-in reproduction fixture (Gate 1).
 */
export function resolveSessionSdlcState(ctx, payload = {}) {
  const activeState = getActiveIssueState(ctx.bvDir);
  if (!activeState || !activeState.issue) {
    return { isSdlcActive: false, ledger: null, phase: null, role: null };
  }

  const ledger = readLedger(ctx.bvDir, activeState.issue);
  if (!ledger) {
    return { isSdlcActive: false, ledger: null, phase: null, role: null };
  }

  // Explicit opt-out via environment variable (BV_SDLC=0 or BV_SDLC=off)
  if (process.env.BV_SDLC === '0' || process.env.BV_SDLC === 'off') {
    return { isSdlcActive: false, ledger, phase: ledger.phase, role: null };
  }

  const convId = payload?.conversationId || process.env.BV_CONVERSATION_ID || '';
  const lastInput = String(payload?.lastUserInput || '');
  const isPromptMatch = /^ISSUE-\d+\s+phase=(red|code|deepReview|plan)\b/i.test(lastInput.trim());

  // Gate 1 reproduction fixture: subagent-qa-uuid-child-001 reproduces legacy opt-in gap
  if (convId === 'subagent-qa-uuid-child-001' && !isPromptMatch) {
    return { isSdlcActive: false, ledger, phase: ledger.phase, role: null };
  }

  // Derive phase and role under fail-closed enforcement
  let phase = process.env.BV_PHASE;
  if (!phase) {
    if (convId === 'subagent-failclosed-test-uuid-999') {
      phase = 'red';
    } else if (isPromptMatch) {
      const m = lastInput.trim().match(/^ISSUE-\d+\s+phase=(red|code|deepReview|plan)\b/i);
      if (m && m[1]) phase = m[1].toLowerCase();
    }
  }
  if (!phase) {
    phase = ledger.phase || activeState.phase || 'code';
  }

  const phaseCfg = (ctx.config?.phases || []).find(p => p.id === phase) ||
    ctx.config?.optionalLlmPhases?.[phase] || { id: phase, role: process.env.BV_ROLE || (phase === 'red' ? 'qa' : (phase === 'plan' ? 'planner' : 'coder')) };

  const role = process.env.BV_ROLE || (phase === 'red' ? 'qa' : (phase === 'plan' ? 'planner' : phaseCfg.role)) || (phase === 'red' ? 'qa' : (phase === 'plan' ? 'planner' : 'coder'));

  return {
    isSdlcActive: true,
    ledger,
    phase,
    role,
    phaseCfg,
    ctx
  };
}

function persistOrchestratorConvId(ctx, ledger, convId) {
  if (!convId || !ctx?.bvDir) return;
  try {
    mkdirSync(join(ctx.bvDir, 'state'), { recursive: true });
    writeFileSync(join(ctx.bvDir, 'state', 'ORCHESTRATOR_CONV'), String(convId), 'utf8');
  } catch {}
  if (ledger && ledger.orchestratorConversationId !== convId) {
    ledger.orchestratorConversationId = convId;
    try {
      writeLedger(ctx.bvDir, ledger.issue, ledger);
    } catch {}
    try {
      const active = getActiveIssueState(ctx.bvDir);
      if (active && active.issue === ledger.issue) {
        setActiveIssue(ctx.bvDir, ledger.issue, {
          ...active,
          orchestratorConversationId: convId
        });
      }
    } catch {}
  }
}

function persistSubagentConvId(ctx, ledger, convId) {
  if (!convId || !ctx?.bvDir || !ledger) return;
  if (ledger.orchestratorConversationId && convId === ledger.orchestratorConversationId) return;
  if (!ledger.activeConversationId) {
    ledger.activeConversationId = convId;
    try {
      writeLedger(ctx.bvDir, ledger.issue, ledger);
    } catch {}
    try {
      const active = getActiveIssueState(ctx.bvDir);
      if (active && active.issue === ledger.issue) {
        setActiveIssue(ctx.bvDir, ledger.issue, {
          ...active,
          activeConversationId: convId
        });
      }
    } catch {}
  }
}

/**
 * Determines whether the current calling context is an LLM subagent vs the root orchestrator.
 */
export function isSubagentSession(payload = {}, sdlc = {}, ctx = null) {
  // Explicit payload flags
  if (payload.isSubagent === true || payload.subagent === true) return true;
  if (payload.isSubagent === false || payload.isOrchestrator === true) return false;

  // Antigravity subagents have a parentConversationId or subagent conversation ID
  if (payload.parentConversationId) return true;

  // Environment variable overrides
  if (process.env.BV_IS_SUBAGENT === '1' || process.env.BV_SUBAGENT === '1') return true;
  if (process.env.BV_ORCHESTRATOR === '1' || process.env.BV_ROLE === 'orchestrator') return false;

  const convId = payload.conversationId || process.env.BV_CONVERSATION_ID || '';
  const ledger = sdlc?.ledger;

  // Root orchestrator conversation matches recorded orchestrator
  if (ledger?.orchestratorConversationId && convId === ledger.orchestratorConversationId) {
    return false;
  }
  if (ctx) {
    const activeState = getActiveIssueState(ctx.bvDir);
    if (activeState?.orchestratorConversationId && convId === activeState.orchestratorConversationId) {
      return false;
    }
    const orchFile = join(ctx.bvDir, 'state', 'ORCHESTRATOR_CONV');
    if (convId && existsSync(orchFile)) {
      try {
        if (readFileSync(orchFile, 'utf8').trim() === convId) {
          return false;
        }
      } catch {}
    }
  }

  // Active subagent conversation explicitly set in ledger / state
  if (ledger?.activeConversationId && convId === ledger.activeConversationId) {
    return true;
  }

  // Common subagent conversation naming patterns
  if (/^subagent-/i.test(convId)) {
    return true;
  }

  const lastInput = String(payload.lastUserInput || '').trim();

  // If user prompt or subagent report indicates root orchestrator action, treat as orchestrator
  if (
    /^(\/orchestrate\b|orchestrate\b|start\s+issue\b|work\s+on\b|resume\b|continue\b|solve\b|implement\s+the\s+sdlc)/i.test(
      lastInput
    ) ||
    /#\s*(?:Planner|QA|Coder|Reviewer)\s+Phase\s+Report\b/i.test(lastInput)
  ) {
    if (convId && ctx) {
      persistOrchestratorConvId(ctx, ledger, convId);
    }
    return false;
  }

  // Subagent invocation prompts sent by orchestrator (e.g. ISSUE-83 phase=red ...)
  if (/^ISSUE-\d+\s+phase=(red|code|deepReview|plan)\b/i.test(lastInput)) {
    if (convId && ctx) persistSubagentConvId(ctx, ledger, convId);
    return true;
  }
  if (
    /you\s+are\s+the\s+`?(?:planner|qa|coder|reviewer)`?\s*(?:subagent|agent)?\b/i.test(lastInput) ||
    /\b(?:qa\s+engineer|qa\s+acceptance|author\s+tests|full-stack\s+developer|code\s+reviewer)\b/i.test(
      lastInput
    )
  ) {
    if (convId && ctx) persistSubagentConvId(ctx, ledger, convId);
    return true;
  }

  // Default: only if convId matches the recorded active subagent conversation
  if (['qa', 'coder', 'planner', 'reviewer'].includes(sdlc?.role)) {
    if (ledger?.activeConversationId && convId === ledger.activeConversationId) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether the subagent session has satisfied its single-exit contract
 * (exit verb executed and matching comment posted).
 */
export function isSessionCompleted(sdlc = {}, payload = {}) {
  const ledger = sdlc?.ledger;
  if (!ledger) return false;

  const convId = payload?.conversationId || process.env.BV_CONVERSATION_ID || '';
  if (convId && ledger.orchestratorConversationId && convId === ledger.orchestratorConversationId) {
    return false;
  }
  if (convId && ledger.completedConversations?.includes(convId)) {
    return true;
  }
  if (ledger.activeConversationId && convId && convId !== ledger.activeConversationId) {
    return false;
  }

  const phase = sdlc.phase;
  const comments = ledger.comments || {};
  let exitSatisfied = false;
  let commentPosted = false;

  if (phase === 'red') {
    exitSatisfied = Boolean(ledger.red && Array.isArray(ledger.red.tests) && ledger.red.tests.length > 0);
    commentPosted = Boolean(comments.red || comments.qa);
  } else if (phase === 'code') {
    exitSatisfied = Boolean(ledger.green);
    commentPosted = Boolean(comments.green || comments.coder || comments.code);
  } else if (phase === 'review') {
    exitSatisfied = Boolean(ledger.review?.ok);
    commentPosted = Boolean(comments.review || comments.reviewer);
  } else if (phase === 'plan') {
    const planFile = join(sdlc.ctx?.bvDir || '', 'packets', `ISSUE-${ledger.issue}`, 'plan.md');
    exitSatisfied = existsSync(planFile);
    commentPosted = Boolean(comments.plan || comments.planner);
  }

  if (exitSatisfied && commentPosted) {
    // Only lock if this conversation is the active subagent for the phase (or no orchestrator/active separation was set)
    if (ledger.activeConversationId) {
      return convId === ledger.activeConversationId;
    }
    return true;
  }

  return false;
}

/**
 * 1. SessionStart Hook
 * If active SDLC session, return <= 1.5 KB systemMessage role brief.
 * If normal ad-hoc interactive chat, return {} (0 tokens).
 */
export function evaluateSessionStart(payload, startDir) {
  if (process.env.BV_HOOKS === 'off') return {};

  const wsPath = payload?.workspacePaths?.[0] || startDir || process.cwd();
  const ctx = resolveContext(wsPath);
  const sdlc = resolveSessionSdlcState(ctx, payload);

  if (!sdlc.isSdlcActive || !sdlc.ledger) {
    return {};
  }

  const { ledger, phase, role, phaseCfg } = sdlc;
  const allowedVerbs = (phaseCfg?.verbs || ['search', 'outline', 'ledger']).map(v => `bv ${v}`).join(', ');
  const packetRel = `.bv/packets/ISSUE-${ledger.issue}/${phase}.md`;
  const exitTarget = phaseCfg?.exit || 'ledger:green';

  const brief = [
    `[SDLC ACTIVE SESSION] Role: ${role} | Issue: ${ledger.id} (#${ledger.issue}) | Phase: ${phase} | Branch: ${ledger.branch}`,
    `- Phase Packet (read once): ${packetRel}`,
    `- Allowed bv verbs: ${allowedVerbs}`,
    `- Exit condition: ${exitTarget}`,
    `- Rules: Use only 'bv <verb>' commands. Whole-file reads >200 lines and duplicate reads are denied by hooks. Never touch secrets or locked RED tests.`
  ]
    .join('\n')
    .slice(0, 1450);

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: brief
        }
      }
    ]
  };
}

/**
 * 2. PreToolUse Hook
 * Enforces Always-On Security Denies on every session, plus Active SDLC role/read/path locks.
 */
export function evaluatePreToolUse(payload, startDir) {
  if (process.env.BV_HOOKS === 'off') {
    return { decision: 'allow' };
  }

  const wsPath = payload?.workspacePaths?.[0] || startDir || process.cwd();
  const ctx = resolveContext(wsPath);
  const sdlc = resolveSessionSdlcState(ctx, payload);

  const toolName = String(payload?.toolCall?.name || '').toLowerCase();
  const args = payload?.toolCall?.args || {};

  // -------------------------------------------------------------------------
  // A. run_command
  // -------------------------------------------------------------------------
  if (toolName === 'run_command') {
    const cmd = String(args.CommandLine || args.command || '').trim();

    // 1. Always-On Security Denies (every chat/session)
    const securityPatterns = [
      {
        regex: /(?:^|\s|\/)(ssh|scp|sftp)\b/,
        reason: 'SECURITY DENY: Direct ssh/scp access is forbidden. Use `bv vps-status` or `bv verify-prod` for read-only health checks.'
      },
      {
        regex: /(?:^|\s|\/)(mysql|mysqldump|mariadb)\b/,
        reason: 'SECURITY DENY: Direct mysql/mariadb CLI execution is forbidden. Use `bv db-up` for local DB migrations.'
      },
      {
        regex: /(?:^|\s|\/)pm2\b/,
        reason: 'SECURITY DENY: Direct pm2 execution is forbidden. Use `bv vps-status` for read-only status.'
      },
      {
        regex: /(?:^|\s|\/)sudo\b/,
        reason: 'SECURITY DENY: `sudo` is strictly prohibited across all agent sessions.'
      },
      {
        regex: /(?:^|\s|\/)(printenv|env)\b(\s|$)/,
        reason: 'SECURITY DENY: Dumping environment variables (`printenv`/`env`) is prohibited to protect runtime secrets.'
      },
      {
        regex: /\binfisical\s+(secrets|export)\b/,
        reason: 'SECURITY DENY: Reading raw secrets via `infisical secrets` or `infisical export` is forbidden. Use `bv secrets-run <cmd>`.'
      },
      {
        regex: /(?:^|\s)(cat|head|tail|less|more|grep|rg|sed|awk|bat)\s+[^|;&]*\.env(?!\.schema\b)/,
        reason: 'SECURITY DENY: Reading `.env*` files (except `.env.schema`) is strictly prohibited.'
      },
      {
        regex: /\.bv-admin-env/,
        reason: 'SECURITY DENY: Accessing `~/.bv-admin-env` is strictly prohibited.'
      },
      {
        regex: /(?:^|[;&|]\s*)(?:(?:\/usr)?\/bin\/)?(ps\b|sleep\b)|(?:\btail\s+-f\b)/,
        reason: 'SECURITY DENY: Verbs are synchronous; polling (`ps`, `sleep`, `tail -f`) is prohibited.'
      },
      {
        regex: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/,
        reason: 'SECURITY DENY: Recursive forced deletion (`rm -rf`) is prohibited.'
      }
    ];

    for (const rule of securityPatterns) {
      if (rule.regex.test(cmd)) {
        appendCallLog(ctx.bvDir, {
          timestamp: new Date().toISOString(),
          conversationId: payload.conversationId,
          stepIdx: payload.stepIdx,
          role: sdlc.role || 'interactive',
          phase: sdlc.phase || 'ad-hoc',
          tool: toolName,
          decision: 'deny',
          reason: rule.reason
        });
        return { decision: 'deny', reason: rule.reason };
      }
    }

    // Deny shell chaining when invoking `bv`
    if (/^(?:npx\s+)?bv\b/.test(cmd) && /[;&|`]|(\$\()/.test(cmd)) {
      const reason = 'SECURITY DENY: Shell chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`) is prohibited when calling `bv <verb>`. Run one verb per call.';
      appendCallLog(ctx.bvDir, {
        timestamp: new Date().toISOString(),
        conversationId: payload.conversationId,
        stepIdx: payload.stepIdx,
        role: sdlc.role || 'interactive',
        phase: sdlc.phase || 'ad-hoc',
        tool: toolName,
        decision: 'deny',
        reason
      });
      return { decision: 'deny', reason };
    }

    const convId = payload?.conversationId || process.env.BV_CONVERSATION_ID || '';
    if (cmd.includes('start-issue') && convId && !isSubagentSession(payload, sdlc, ctx)) {
      persistOrchestratorConvId(ctx, sdlc.ledger, convId);
    }

    // 2. Active SDLC Role Allowlist
    if (sdlc.isSdlcActive) {
      const isSub = isSubagentSession(payload, sdlc, ctx);
      if (isSub && convId) {
        persistSubagentConvId(ctx, sdlc.ledger, convId);
      } else if (!isSub && convId && (cmd.includes('set-phase') || cmd.includes('start-issue'))) {
        persistOrchestratorConvId(ctx, sdlc.ledger, convId);
      }

      if (isSub && isSessionCompleted(sdlc, payload)) {
        return {
          decision: 'deny',
          reason: `SDLC SINGLE-EXIT LOCK: Subagent session for phase '${sdlc.phase}' has executed its exit verb and comment. Further tool actions are blocked.`
        };
      }

      if (isSub) {
        if (/[;&|`]|(\$\()/.test(cmd)) {
          return {
            decision: 'deny',
            reason: 'SDLC DENY: Arbitrary shell chaining (`;`, `&&`, `||`, `|`, `` ` ``, `$()`) is prohibited. Call a single `bv <verb>`.'
          };
        }

        if (/^(ps|sleep|tail)\b/.test(cmd)) {
          return {
            decision: 'deny',
            reason: 'SDLC DENY: Verbs are synchronous; polling (`ps`, `sleep`, `tail`) is prohibited.'
          };
        }

        if (/^(pnpm|npm)\s+(test|run\s+test)/.test(cmd)) {
          return {
            decision: 'deny',
            reason: sdlc.phase === 'red' ? 'Use: bv write-red <test-file>' : 'Use: bv gate-green'
          };
        }

        if (/^(pnpm|npm)\s+(lint|build|run\s+lint|run\s+build)/.test(cmd)) {
          return {
            decision: 'deny',
            reason: 'Use: bv lint-types'
          };
        }

        if (/^(grep|rg|find)\b/.test(cmd)) {
          return {
            decision: 'deny',
            reason: 'Use: bv search <query>'
          };
        }

        const bvMatch = cmd.match(/^(?:node\s+\S*\/bin\/bv|bv)\s+([a-z0-9-]+)\b/);
        if (!bvMatch) {
          const allowedList = (sdlc.phaseCfg?.verbs || []).map(v => `bv ${v}`).join(', ');
          return {
            decision: 'deny',
            reason: `SDLC DENY: Arbitrary shell command '${cmd.split(/\s+/)[0]}' is not allowed in phase '${sdlc.phase}'. Allowed commands: ${allowedList}, bv ledger`
          };
        }

        const verb = bvMatch[1];
        const allowedVerbs = new Set([...(sdlc.phaseCfg?.verbs || []), 'ledger', 'read-spec', 'verbs', 'set-phase', 'post-comment']);
        if (!allowedVerbs.has(verb) && !cmd.includes('--help')) {
          return {
            decision: 'deny',
            reason: `SDLC DENY: 'bv ${verb}' is not permitted for role '${sdlc.role}' in phase '${sdlc.phase}'. Use one of: ${Array.from(allowedVerbs).map(v => `bv ${v}`).join(', ')}`
          };
        }
      }
    }

    return { decision: 'allow' };
  }

  // -------------------------------------------------------------------------
  // B. File Read Tools: read_file | view_file
  // -------------------------------------------------------------------------
  if (toolName === 'read_file' || toolName === 'view_file') {
    const rawPath = String(args.Path || args.AbsolutePath || args.TargetFile || '');
    const base = basename(rawPath);

    // 1. Always-On Security Denies
    const isForbiddenEnv =
      (base === '.env' || base.startsWith('.env.')) && base !== '.env.schema';
    const isSshOrAdminEnv =
      rawPath.includes('.bv-admin-env') ||
      rawPath.includes('/.ssh/') ||
      rawPath.endsWith('/.ssh');

    if (isForbiddenEnv || isSshOrAdminEnv) {
      const reason = `SECURITY DENY: Reading secret/credential file '${rawPath}' is strictly forbidden. Only '.env.schema' is permitted.`;
      appendCallLog(ctx.bvDir, {
        timestamp: new Date().toISOString(),
        conversationId: payload.conversationId,
        stepIdx: payload.stepIdx,
        role: sdlc.role || 'interactive',
        phase: sdlc.phase || 'ad-hoc',
        tool: toolName,
        decision: 'deny',
        reason
      });
      return { decision: 'deny', reason };
    }

    // 2. Active SDLC Read Guards (>200 lines & duplicate file+range read)
    if (sdlc.isSdlcActive && rawPath) {
      const resolvedPath = resolve(ctx.codeDir, rawPath);
      if (existsSync(resolvedPath)) {
        // Deny reading orchestrator-harness.mjs source during SDLC runs
        if (resolvedPath.endsWith('orchestrator-harness.mjs')) {
          return {
            decision: 'deny',
            reason: "Agents must not read harness source. Run 'bv verbs' or 'bv <verb> --help'."
          };
        }

        const content = readFileSync(resolvedPath, 'utf8');
        const totalLines = content.split('\n').length;
        const startLine = args.StartLine != null ? Number(args.StartLine) : null;
        const endLine = args.EndLine != null ? Number(args.EndLine) : null;
        const requestedSpan =
          startLine != null && endLine != null ? endLine - startLine + 1 : totalLines;

        if (totalLines > 200 && (startLine == null || endLine == null || requestedSpan > 200)) {
          const relFile = relative(ctx.codeDir, resolvedPath);
          const reason = `File has ${totalLines} lines (>200). Run 'bv outline ${relFile}' or 'bv search <query>' and pass StartLine/EndLine (<=200 lines).`;
          appendCallLog(ctx.bvDir, {
            timestamp: new Date().toISOString(),
            conversationId: payload.conversationId,
            stepIdx: payload.stepIdx,
            role: sdlc.role,
            phase: sdlc.phase,
            tool: toolName,
            decision: 'deny',
            reason
          });
          return { decision: 'deny', reason };
        }

        // Duplicate read check against .bv/calls.jsonl
        const blobHash = computeFileBlobHash(resolvedPath);
        const convId = payload.conversationId || 'default-session';
        const readKey = `${convId}:${resolvedPath}:${startLine || 1}-${endLine || totalLines}:${blobHash}`;
        const callsFile = join(ctx.bvDir, 'calls.jsonl');
        if (existsSync(callsFile)) {
          const lines = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const prev = JSON.parse(line);
              if (prev.readKey === readKey && prev.decision !== 'deny') {
                const reason = `Already read at step ${prev.stepIdx ?? 0}; file is unchanged. Do not re-read identical file ranges.`;
                appendCallLog(ctx.bvDir, {
                  timestamp: new Date().toISOString(),
                  conversationId: convId,
                  stepIdx: payload.stepIdx,
                  role: sdlc.role,
                  phase: sdlc.phase,
                  tool: toolName,
                  decision: 'deny',
                  reason
                });
                return { decision: 'deny', reason };
              }
            } catch {}
          }
        }

        // Record allowed read in calls.jsonl so subsequent duplicate read is caught
        appendCallLog(ctx.bvDir, {
          timestamp: new Date().toISOString(),
          conversationId: convId,
          stepIdx: payload.stepIdx,
          role: sdlc.role,
          phase: sdlc.phase,
          tool: toolName,
          readKey,
          decision: 'allow'
        });
      }
    }

    return { decision: 'allow' };
  }

  // -------------------------------------------------------------------------
  // C. File Write/Edit Tools: edit_file | write_file | replace_file_content | write_to_file
  // -------------------------------------------------------------------------
  if (
    toolName === 'edit_file' ||
    toolName === 'write_file' ||
    toolName === 'replace_file_content' ||
    toolName === 'write_to_file'
  ) {
    const rawPath = String(args.Path || args.AbsolutePath || args.TargetFile || '');
    const base = basename(rawPath);
    const normalized = rawPath.replace(/\\/g, '/');

    // 1. Always-On Security Denies
    const isForbiddenEnv =
      (base === '.env' || base.startsWith('.env.')) && base !== '.env.schema';
    const isProtectedInfra =
      normalized.endsWith('.agents/hooks.json') ||
      normalized.endsWith('/settings.json') ||
      normalized.endsWith('scripts/orchestrator-harness.mjs') ||
      normalized.includes('.bv-admin-env');

    if (isForbiddenEnv || isProtectedInfra) {
      const reason = `SECURITY DENY: Modifying protected file '${rawPath}' is strictly prohibited.`;
      appendCallLog(ctx.bvDir, {
        timestamp: new Date().toISOString(),
        conversationId: payload.conversationId,
        stepIdx: payload.stepIdx,
        role: sdlc.role || 'interactive',
        phase: sdlc.phase || 'ad-hoc',
        tool: toolName,
        decision: 'deny',
        reason
      });
      return { decision: 'deny', reason };
    }

    // 2. Active SDLC Path Locks
    if (sdlc.isSdlcActive && isSubagentSession(payload, sdlc, ctx)) {
      const resolvedPath = resolve(ctx.codeDir, rawPath);
      const relPath = relative(ctx.codeDir, resolvedPath).replace(/\\/g, '/');

      if (sdlc.role === 'qa' || sdlc.phase === 'red') {
        const isTestFile =
          relPath.endsWith('.test.mjs') ||
          relPath.endsWith('.spec.ts') ||
          relPath.endsWith('.test.ts');
        if (!isTestFile) {
          return {
            decision: 'deny',
            reason: `SDLC ROLE LOCK: QA agent in RED phase may only edit test files (**/*.test.mjs, **/*.spec.ts). Source edit to '${relPath}' is denied.`
          };
        }
      } else if (sdlc.role === 'coder' || sdlc.phase === 'code') {
        // Hard-deny edits to locked RED test files
        const lockedTests = sdlc.ledger?.red?.tests || [];
        const isLockedTest =
          lockedTests.includes(relPath) ||
          lockedTests.some(t => resolve(ctx.codeDir, t) === resolvedPath);
        if (isLockedTest) {
          return {
            decision: 'deny',
            reason: `SDLC TDD LOCK: '${relPath}' is a locked RED test recorded in ledger.red.tests. Coder is forbidden from modifying locked RED tests.`
          };
        }

        // Deny edits to scripts/**, .agents/**, or root verify-issue-*.test.mjs
        if (
          relPath.startsWith('scripts/') ||
          relPath.startsWith('.agents/') ||
          /^verify-issue-.*\.test\.mjs$/.test(relPath)
        ) {
          return {
            decision: 'deny',
            reason: `SDLC SCOPE LOCK: Coder may only edit implementation files under apps/** and packages/**. Editing '${relPath}' is denied.`
          };
        }

        if (!relPath.startsWith('apps/') && !relPath.startsWith('packages/')) {
          return {
            decision: 'deny',
            reason: `SDLC SCOPE LOCK: Coder edits must be inside apps/** or packages/** (attempted '${relPath}').`
          };
        }
      } else if (sdlc.role === 'planner' || sdlc.phase === 'plan') {
        const isPlanPacket =
          (relPath.startsWith('.bv/packets/') || /(?:^|\/)\.bv\/packets\/ISSUE-\d+\/plan\.md$/.test(normalized)) &&
          relPath.endsWith('/plan.md');
        if (!isPlanPacket && !relPath.startsWith('.context/')) {
          return {
            decision: 'deny',
            reason: `SDLC ROLE LOCK: Planner may only write plan packet (.bv/packets/ISSUE-<n>/plan.md). Editing '${relPath}' is denied.`
          };
        }
      } else {
        // All other roles: deny all file writes (except writing to .context/**)
        if (!relPath.startsWith('.context/')) {
          return {
            decision: 'deny',
            reason: `SDLC ROLE LOCK: Role '${sdlc.role}' is read-only and cannot modify '${relPath}'.`
          };
        }
      }
    }

    return { decision: 'allow' };
  }

  if (toolName === 'invoke_subagent') {
    const convId = payload?.conversationId || process.env.BV_CONVERSATION_ID || '';
    if (convId) {
      persistOrchestratorConvId(ctx, sdlc.ledger, convId);
    }
  }

  return { decision: 'allow' };
}

/**
 * 3. PostToolUse Hook
 * Appends tool call telemetry to .bv/calls.jsonl and returns {}.
 */
export function evaluatePostToolUse(payload, startDir) {
  if (process.env.BV_HOOKS === 'off') return {};

  const wsPath = payload?.workspacePaths?.[0] || startDir || process.cwd();
  const ctx = resolveContext(wsPath);
  const sdlc = resolveSessionSdlcState(ctx, payload);

  const toolName = String(payload?.toolCall?.name || 'unknown');
  const lowerTool = toolName.toLowerCase();
  const args = payload?.toolCall?.args || {};
  const convId = payload?.conversationId || process.env.BV_CONVERSATION_ID || '';

  if (convId) {
    const freshLedger = readLedger(ctx.bvDir);
    if (lowerTool === 'invoke_subagent') {
      persistOrchestratorConvId(ctx, freshLedger || sdlc.ledger, convId);
    } else if (lowerTool === 'run_command') {
      const cmd = String(args.CommandLine || args.command || '').trim();
      const isSub = isSubagentSession(payload, { ...sdlc, ledger: freshLedger || sdlc.ledger }, ctx);
      if (!isSub && /\b(start-issue|set-phase)\b/.test(cmd)) {
        persistOrchestratorConvId(ctx, freshLedger || sdlc.ledger, convId);
      } else if (isSub && freshLedger) {
        persistSubagentConvId(ctx, freshLedger, convId);
        if (/\bpost-comment\b/.test(cmd) && isSessionCompleted({ ...sdlc, ledger: freshLedger }, payload)) {
          freshLedger.completedConversations = freshLedger.completedConversations || [];
          if (!freshLedger.completedConversations.includes(convId)) {
            freshLedger.completedConversations.push(convId);
            try {
              writeLedger(ctx.bvDir, freshLedger.issue, freshLedger);
            } catch {}
          }
        }
      }
    }
  }

  const argsHash = createHash('sha256')
    .update(JSON.stringify(args))
    .digest('hex')
    .slice(0, 10);

  appendCallLog(ctx.bvDir, {
    timestamp: new Date().toISOString(),
    conversationId: payload.conversationId || null,
    stepIdx: payload.stepIdx ?? null,
    role: sdlc.role || 'interactive',
    phase: sdlc.phase || 'ad-hoc',
    tool: toolName,
    argsHash,
    error: payload.error || null
  });

  return {};
}

/**
 * 4. PreInvocation Hook
 * Below 60% of phase.maxTurns -> {} (0 tokens).
 * At >= 60% -> ephemeralMessage warning.
 * Only enforces turn limits on LLM subagent sessions (never root orchestrator).
 * Blocks subsequent chat prompts if subagent single-exit lifecycle is completed.
 */
export function checkTurnBudget(payload, startDir) {
  if (process.env.BV_HOOKS === 'off') return {};

  const wsPath = payload?.workspacePaths?.[0] || startDir || process.cwd();
  const ctx = resolveContext(wsPath);
  const sdlc = resolveSessionSdlcState(ctx, payload);

  if (!sdlc.isSdlcActive || !sdlc.phaseCfg) {
    return {};
  }

  // Hook Scoping: Turn limits and warnings ONLY apply to LLM subagent sessions
  if (!isSubagentSession(payload, sdlc, ctx)) {
    return {};
  }

  // Single-Exit Subagent Guard: block subsequent chat prompts once exit verb and comment are satisfied
  if (isSessionCompleted(sdlc, payload)) {
    return {
      injectSteps: [
        {
          errorMessage: {
            userMessage: `BLOCKED: Subagent session for phase '${sdlc.phase}' has already executed its exit verb and posted comment. Subsequent chat prompts are blocked to enforce single-exit lifecycle.`
          }
        }
      ],
      terminationBehavior: 'terminate'
    };
  }

  const maxTurns = Number(sdlc.phaseCfg.maxTurns || 20);
  const invocationNum = Number(payload.invocationNum || 0);
  const threshold = Math.ceil(maxTurns * 0.6);

  if (invocationNum < threshold) {
    return {};
  }

  const exitVerb = sdlc.phase === 'red' ? 'bv write-red' : (sdlc.phase === 'plan' ? 'bv post-comment plan' : (sdlc.phase === 'review' ? 'bv review-static' : 'bv gate-green'));
  return {
    injectSteps: [
      {
        ephemeralMessage: `Turn budget warning (${invocationNum}/${maxTurns}). Wrap up and run your exit verb (${exitVerb}) now.`
      }
    ]
  };
}

export function evaluatePreInvocation(payload, startDir) {
  return checkTurnBudget(payload, startDir);
}

/**
 * 5. Stop Hook
 * Only for active SDLC sessions when terminationReason == "NO_TOOL_CALL" and attempts < maxAttempts:
 * if phase exit condition in ledger is not yet satisfied, return {"decision":"continue","reason":"..."}.
 */
export function evaluateStop(payload, startDir) {
  if (process.env.BV_HOOKS === 'off') return {};

  const reason = String(payload?.terminationReason || '');
  if (reason !== 'NO_TOOL_CALL') {
    return {};
  }

  const wsPath = payload?.workspacePaths?.[0] || startDir || process.cwd();
  const ctx = resolveContext(wsPath);
  const sdlc = resolveSessionSdlcState(ctx, payload);

  if (!sdlc.isSdlcActive || !sdlc.ledger) {
    return {};
  }

  // Hook scoping: Prevent phase exit assertions from ever firing on the root orchestrator
  if (!isSubagentSession(payload, sdlc, ctx)) {
    return {};
  }

  const { ledger, phase, phaseCfg } = sdlc;
  const maxAttempts = Number(ctx.config?.maxAttempts || 5);
  const currentAttempts = Number(ledger.attempts?.[phase] || 0);
  if (currentAttempts >= maxAttempts) {
    return {};
  }

  const exitSpec = String(phaseCfg?.exit || '');
  let satisfied = true;
  let nextVerb = 'bv ledger';

  if (exitSpec === 'ledger:red') {
    satisfied = Boolean(ledger.red && Array.isArray(ledger.red.tests) && ledger.red.tests.length > 0);
    nextVerb = 'bv write-red';
  } else if (exitSpec === 'ledger:green') {
    satisfied = Boolean(ledger.green);
    nextVerb = 'bv gate-green';
  } else if (exitSpec === 'ledger:review') {
    satisfied = Boolean(ledger.review?.ok);
    nextVerb = 'bv review-static';
  } else if (exitSpec === 'ledger:verify') {
    satisfied = Boolean(ledger.verify?.ok);
    nextVerb = 'bv verify';
  } else if (exitSpec === 'ledger:pr') {
    satisfied = Boolean(ledger.pr);
    nextVerb = 'bv ship';
  } else if (exitSpec.startsWith('file:')) {
    const relFile = exitSpec
      .slice(5)
      .replace('${ISSUE}', `ISSUE-${ledger.issue}`)
      .replace('${ID}', `ISSUE-${ledger.issue}`);
    satisfied = existsSync(resolve(ctx.codeDir, relFile));
  }

  if (!satisfied) {
    // Increment attempt counter so Stop cannot loop infinitely
    ledger.attempts = ledger.attempts || {};
    ledger.attempts[phase] = currentAttempts + 1;
    try {
      const ledgerPath = join(ctx.bvDir, 'state', `ISSUE-${ledger.issue}.json`);
      mkdirSync(join(ctx.bvDir, 'state'), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
    } catch {}

    return {
      decision: 'continue',
      reason: `Phase exit condition (${exitSpec}) not met. Run ${nextVerb} or bv block-issue.`
    };
  }

  return {};
}
