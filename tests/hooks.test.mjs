import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateSessionStart,
  evaluatePreToolUse,
  evaluatePostToolUse,
  evaluatePreInvocation,
  evaluateStop,
  checkTurnBudget
} from '../lib/hooks.mjs';
import { computeFileBlobHash } from '../lib/core.mjs';

describe('agent-sdlc-kit Hook Enforcement & TDD Unit Suite', () => {
  let tmpWorkspace;

  before(() => {
    tmpWorkspace = mkdtempSync(join(tmpdir(), 'bv-hooks-test-'));
    mkdirSync(join(tmpWorkspace, '.agents'), { recursive: true });
    mkdirSync(join(tmpWorkspace, '.bv', 'state'), { recursive: true });
    mkdirSync(join(tmpWorkspace, 'apps', 'backend', 'src'), { recursive: true });
    writeFileSync(
      join(tmpWorkspace, 'package.json'),
      JSON.stringify({ name: 'test-repo', version: '1.0.0' }),
      'utf8'
    );
    writeFileSync(
      join(tmpWorkspace, '.agents', 'sdlc.config.json'),
      readFileSync(new URL('../templates/sdlc.config.json', import.meta.url), 'utf8'),
      'utf8'
    );
  });

  after(() => {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('Always-On Security Denies: blocks ssh, mysql, pm2, sudo, printenv, env, and .env* across ALL sessions', () => {
    const forbiddenCommands = [
      'ssh linode "mysql -D osos_db"',
      'mysql -u root -p',
      'pm2 restart bv-backend',
      'sudo rm -rf /tmp/x',
      'printenv',
      'env',
      'cat .env.local',
      'cat apps/backend/.env',
      'infisical secrets get ADMIN_PASSWORD',
      'cat ~/.bv-admin-env',
      'bv ledger && bv verify'
    ];

    for (const cmd of forbiddenCommands) {
      const res = evaluatePreToolUse(
        {
          conversationId: 'adhoc-chat-1',
          workspacePaths: [tmpWorkspace],
          toolCall: { name: 'run_command', args: { CommandLine: cmd } }
        },
        tmpWorkspace
      );
      assert.strictEqual(res.decision, 'deny', `Expected command "${cmd}" to be denied`);
      assert.ok(res.reason && res.reason.includes('SECURITY DENY'), `Expected SECURITY DENY reason for "${cmd}"`);
    }
  });

  it('Always-On File Security Denies: blocks reading/writing .env* (except .env.schema) on both CLI and IDE tool names', () => {
    for (const tool of ['read_file', 'view_file', 'edit_file', 'write_file', 'replace_file_content', 'write_to_file']) {
      const badEnvRes = evaluatePreToolUse(
        {
          conversationId: 'adhoc-chat-2',
          workspacePaths: [tmpWorkspace],
          toolCall: { name: tool, args: { Path: '.env.local', AbsolutePath: '/tmp/.env.local' } }
        },
        tmpWorkspace
      );
      assert.strictEqual(badEnvRes.decision, 'deny', `Expected ${tool} on .env.local to be denied`);

      const schemaAllowedRes = evaluatePreToolUse(
        {
          conversationId: 'adhoc-chat-2',
          workspacePaths: [tmpWorkspace],
          toolCall: { name: tool, args: { Path: '.env.schema', AbsolutePath: join(tmpWorkspace, '.env.schema') } }
        },
        tmpWorkspace
      );
      assert.strictEqual(schemaAllowedRes.decision, 'allow', `Expected ${tool} on .env.schema to be allowed`);
    }
  });

  it('Interactive Chat Safety Scoping: normal ad-hoc chats get 0 tokens on SessionStart and are not locked by SDLC role rules', () => {
    const startRes = evaluateSessionStart(
      {
        conversationId: 'normal-user-chat',
        workspacePaths: [tmpWorkspace]
      },
      tmpWorkspace
    );
    assert.deepStrictEqual(startRes, {}, 'Ad-hoc chat SessionStart must return {} (0 tokens)');

    const stopRes = evaluateStop(
      {
        conversationId: 'normal-user-chat',
        workspacePaths: [tmpWorkspace],
        terminationReason: 'NO_TOOL_CALL'
      },
      tmpWorkspace
    );
    assert.deepStrictEqual(stopRes, {}, 'Ad-hoc chat Stop must never block');
  });

  it('Active SDLC Session: enforces >200 line read guard, duplicate read guard, QA vs Coder path locks, and Stop continuation', () => {
    const sdlcConvId = 'sdlc-conv-99';
    const lockedTestRel = 'verify-issue-099.test.mjs';
    const lockedTestFull = join(tmpWorkspace, lockedTestRel);
    writeFileSync(lockedTestFull, '// locked test\nprocess.exit(1);\n', 'utf8');
    const lockedBlob = computeFileBlobHash(lockedTestFull);

    // Create a 250-line source file
    const bigFileRel = 'apps/backend/src/big.service.ts';
    const bigFileFull = join(tmpWorkspace, bigFileRel);
    writeFileSync(
      bigFileFull,
      Array.from({ length: 250 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'),
      'utf8'
    );

    // Activate issue 99 in RED phase first
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ACTIVE_ISSUE'),
      JSON.stringify({ issue: 99, activeConversationId: sdlcConvId, phase: 'red' }),
      'utf8'
    );
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ISSUE-99.json'),
      JSON.stringify({
        issue: 99,
        id: 'ISSUE-099',
        branch: 'feature/issue-099',
        phase: 'red',
        activeConversationId: sdlcConvId,
        attempts: {},
        failureHashes: {},
        red: null,
        green: null
      }),
      'utf8'
    );

    // 1. SessionStart injects <= 1.5 KB brief
    const ssRes = evaluateSessionStart({ conversationId: sdlcConvId, workspacePaths: [tmpWorkspace] }, tmpWorkspace);
    const msg = ssRes.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.ok(msg.includes('Role: qa') && msg.includes('ISSUE-099'), 'SessionStart injects role brief');
    assert.ok(Buffer.byteLength(msg, 'utf8') <= 1536, 'SessionStart brief is <= 1.5 KB');

    // 2. QA in RED phase cannot edit apps/backend/src/big.service.ts
    const qaEditSrc = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'edit_file', args: { Path: bigFileRel } }
      },
      tmpWorkspace
    );
    assert.strictEqual(qaEditSrc.decision, 'deny', 'QA must be denied editing source files');

    // QA CAN edit verify-issue-099.test.mjs
    const qaEditTest = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'edit_file', args: { Path: lockedTestRel } }
      },
      tmpWorkspace
    );
    assert.strictEqual(qaEditTest.decision, 'allow', 'QA is allowed to edit test files in RED phase');

    // 3. Transition to CODE phase with locked RED test
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ISSUE-99.json'),
      JSON.stringify({
        issue: 99,
        id: 'ISSUE-099',
        branch: 'feature/issue-099',
        phase: 'code',
        activeConversationId: sdlcConvId,
        attempts: {},
        failureHashes: {},
        red: {
          tests: [lockedTestRel],
          blobHashes: { [lockedTestRel]: lockedBlob },
          treeHash: 'abc1234',
          failing: 1
        },
        green: null
      }),
      'utf8'
    );

    // Coder cannot edit locked RED test (tested with both CLI edit_file and IDE replace_file_content)
    for (const editTool of ['edit_file', 'replace_file_content']) {
      const coderEditLocked = evaluatePreToolUse(
        {
          conversationId: sdlcConvId,
          workspacePaths: [tmpWorkspace],
          toolCall: { name: editTool, args: { Path: lockedTestRel, TargetFile: lockedTestFull } }
        },
        tmpWorkspace
      );
      assert.strictEqual(coderEditLocked.decision, 'deny', `Coder must be denied editing locked RED test via ${editTool}`);
      assert.ok(coderEditLocked.reason.includes('locked RED test'));
    }

    // Coder CAN edit apps/backend/src/big.service.ts
    const coderEditSrc = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'edit_file', args: { Path: bigFileRel } }
      },
      tmpWorkspace
    );
    assert.strictEqual(coderEditSrc.decision, 'allow', 'Coder is allowed to edit apps/** source files');

    // 4. Whole-file read of 250-line file is denied; bounded read (L1-L50) is allowed once, then denied on duplicate read
    const wholeRead = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        stepIdx: 10,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'read_file', args: { Path: bigFileRel } }
      },
      tmpWorkspace
    );
    assert.strictEqual(wholeRead.decision, 'deny', 'Whole-file read > 200 lines must be denied');
    assert.ok(wholeRead.reason.includes('bv outline'), 'Denial reason names bv outline');

    const boundedRead1 = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        stepIdx: 11,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'read_file', args: { Path: bigFileRel, StartLine: 1, EndLine: 50 } }
      },
      tmpWorkspace
    );
    assert.strictEqual(boundedRead1.decision, 'allow', 'First bounded read <= 200 lines is allowed');

    const boundedRead2 = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        stepIdx: 12,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'view_file', args: { AbsolutePath: bigFileFull, StartLine: 1, EndLine: 50 } }
      },
      tmpWorkspace
    );
    assert.strictEqual(boundedRead2.decision, 'deny', 'Second identical file+range read must be denied as duplicate');
    assert.ok(boundedRead2.reason.includes('Already read at step 11'));

    // 5. Polling / non-bv commands in CODE phase are denied with exact bv replacement
    const pnpmTest = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'run_command', args: { CommandLine: 'pnpm test' } }
      },
      tmpWorkspace
    );
    assert.strictEqual(pnpmTest.decision, 'deny');
    assert.strictEqual(pnpmTest.reason, 'Use: bv gate-green');

    const sleepPoll = evaluatePreToolUse(
      {
        conversationId: sdlcConvId,
        workspacePaths: [tmpWorkspace],
        toolCall: { name: 'run_command', args: { CommandLine: 'sleep 5' } }
      },
      tmpWorkspace
    );
    assert.strictEqual(sleepPoll.decision, 'deny');
    assert.ok(sleepPoll.reason.includes('is prohibited'));

    // 6. PreInvocation budget warning at >= 60% of maxTurns (60 * 0.6 = 36)
    const preInvEarly = evaluatePreInvocation(
      { conversationId: sdlcConvId, workspacePaths: [tmpWorkspace], invocationNum: 10 },
      tmpWorkspace
    );
    assert.deepStrictEqual(preInvEarly, {}, 'Below 60% maxTurns returns {} (0 tokens)');

    const preInvLate = evaluatePreInvocation(
      { conversationId: sdlcConvId, workspacePaths: [tmpWorkspace], invocationNum: 36 },
      tmpWorkspace
    );
    assert.ok(
      preInvLate.injectSteps?.[0]?.ephemeralMessage?.includes('Turn budget warning (36/60)'),
      'At >= 60% maxTurns injects ephemeral warning'
    );

    // 7. Stop hook continues when ledger.green is null on NO_TOOL_CALL, but never blocks on USER_CANCELED
    const stopCanceled = evaluateStop(
      { conversationId: sdlcConvId, workspacePaths: [tmpWorkspace], terminationReason: 'USER_CANCELED' },
      tmpWorkspace
    );
    assert.deepStrictEqual(stopCanceled, {}, 'Stop never blocks on USER_CANCELED');

    const stopPremature = evaluateStop(
      { conversationId: sdlcConvId, workspacePaths: [tmpWorkspace], terminationReason: 'NO_TOOL_CALL' },
      tmpWorkspace
    );
    assert.strictEqual(stopPremature.decision, 'continue', 'Stop continues when ledger:green exit condition is unmet');
    assert.ok(stopPremature.reason.includes('bv gate-green'));

    // 8. BV_HOOKS=off human kill switch bypasses all hooks
    process.env.BV_HOOKS = 'off';
    try {
      const killSwitchRes = evaluatePreToolUse(
        {
          conversationId: sdlcConvId,
          workspacePaths: [tmpWorkspace],
          toolCall: { name: 'run_command', args: { CommandLine: 'ssh linode' } }
        },
        tmpWorkspace
      );
      assert.strictEqual(killSwitchRes.decision, 'allow', 'BV_HOOKS=off bypasses hook enforcement');
    } finally {
      delete process.env.BV_HOOKS;
    }
  });

  it('Read Guard: same step replayed by a duplicated hook is not a duplicate; SessionStart resets the guard', () => {
    const convId = 'sdlc-conv-99';
    const rel = 'apps/backend/src/guard-replay.ts';
    writeFileSync(join(tmpWorkspace, rel), 'export const replay = 1;\n', 'utf8');
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ACTIVE_ISSUE'),
      JSON.stringify({ issue: 99, activeConversationId: convId, phase: 'code' }),
      'utf8'
    );
    const read = stepIdx =>
      evaluatePreToolUse(
        {
          conversationId: convId,
          stepIdx,
          workspacePaths: [tmpWorkspace],
          toolCall: { name: 'read_file', args: { Path: rel, StartLine: 1, EndLine: 1 } }
        },
        tmpWorkspace
      );

    assert.strictEqual(read(300).decision, 'allow', 'first read allowed');
    assert.strictEqual(read(300).decision, 'allow', 'same step replayed (hook registered twice) is allowed');
    assert.strictEqual(read(301).decision, 'deny', 'a later identical read is still a duplicate');

    evaluateSessionStart({ conversationId: convId, workspacePaths: [tmpWorkspace] }, tmpWorkspace);
    assert.strictEqual(read(302).decision, 'allow', 'after SessionStart the guard is reset for this conversation');
    assert.strictEqual(read(303).decision, 'deny', 'duplicates are caught again after the reset');
  });

  it('Hook Scoping & Single-Exit Lifecycle: protects root orchestrator and locks completed subagents', () => {
    const orchestratorConvId = 'root-orchestrator-conv-101';
    const subagentConvId = 'subagent-coder-conv-101';
    const issueNum = 101;

    // Activate issue 101 with orchestrator and subagent recorded
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ACTIVE_ISSUE'),
      JSON.stringify({
        issue: issueNum,
        orchestratorConversationId: orchestratorConvId,
        activeConversationId: subagentConvId,
        phase: 'code'
      }),
      'utf8'
    );
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', `ISSUE-${issueNum}.json`),
      JSON.stringify({
        issue: issueNum,
        id: 'ISSUE-101',
        branch: 'feature/issue-101',
        phase: 'code',
        orchestratorConversationId: orchestratorConvId,
        activeConversationId: subagentConvId,
        attempts: {},
        red: { tests: ['verify-issue-101.test.mjs'] },
        green: null,
        comments: {}
      }),
      'utf8'
    );

    // 1. Root orchestrator NEVER receives turn budget warning at high turn count
    const orchPreInv = checkTurnBudget(
      {
        conversationId: orchestratorConvId,
        workspacePaths: [tmpWorkspace],
        invocationNum: 50,
        lastUserInput: 'orchestrate issue 101'
      },
      tmpWorkspace
    );
    assert.deepStrictEqual(orchPreInv, {}, 'Root orchestrator must never receive turn budget warnings');

    // 2. Subagent DOES receive turn budget warning at >= 60% of maxTurns (60 * 0.6 = 36)
    const subPreInv = checkTurnBudget(
      {
        conversationId: subagentConvId,
        workspacePaths: [tmpWorkspace],
        invocationNum: 36,
        lastUserInput: 'ISSUE-101 phase=code implement feature'
      },
      tmpWorkspace
    );
    assert.ok(
      subPreInv.injectSteps?.[0]?.ephemeralMessage?.includes('Turn budget warning (36/60)'),
      'Subagent must receive turn budget warning'
    );

    // 3. Root orchestrator Stop NEVER blocked on NO_TOOL_CALL even when phase exit is unmet
    const orchStop = evaluateStop(
      {
        conversationId: orchestratorConvId,
        workspacePaths: [tmpWorkspace],
        terminationReason: 'NO_TOOL_CALL',
        lastUserInput: 'orchestrate issue 101'
      },
      tmpWorkspace
    );
    assert.deepStrictEqual(orchStop, {}, 'Root orchestrator Stop must never block or return continue decision');

    // 4. Subagent Stop DOES return continue when phase exit condition is unmet
    const subStop = evaluateStop(
      {
        conversationId: subagentConvId,
        workspacePaths: [tmpWorkspace],
        terminationReason: 'NO_TOOL_CALL',
        lastUserInput: 'ISSUE-101 phase=code'
      },
      tmpWorkspace
    );
    assert.strictEqual(subStop.decision, 'continue', 'Subagent Stop continues when exit condition is unmet');

    // 5. Single-Exit Subagent Guard:
    // Mark exit verb (green) satisfied and post green comment
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', `ISSUE-${issueNum}.json`),
      JSON.stringify({
        issue: issueNum,
        id: 'ISSUE-101',
        branch: 'feature/issue-101',
        phase: 'code',
        orchestratorConversationId: orchestratorConvId,
        activeConversationId: subagentConvId,
        attempts: {},
        red: { tests: ['verify-issue-101.test.mjs'] },
        green: { tests: ['verify-issue-101.test.mjs'], durationMs: 120 },
        comments: { coder: { postedAt: new Date().toISOString() } }
      }),
      'utf8'
    );

    // Subsequent chat prompt to this subagent session must be blocked with terminate behavior
    const blockedPrompt = evaluatePreInvocation(
      {
        conversationId: subagentConvId,
        workspacePaths: [tmpWorkspace],
        invocationNum: 1,
        lastUserInput: 'Can you also fix this other thing?'
      },
      tmpWorkspace
    );
    assert.strictEqual(blockedPrompt.terminationBehavior, 'terminate', 'Subagent chat prompt after exit must terminate');
    assert.ok(
      blockedPrompt.injectSteps?.[0]?.errorMessage?.userMessage?.includes('BLOCKED'),
      'ErrorMessage explains single-exit lifecycle block'
    );

    // Tool call in completed subagent session is denied
    const blockedTool = evaluatePreToolUse(
      {
        conversationId: subagentConvId,
        workspacePaths: [tmpWorkspace],
        lastUserInput: 'ISSUE-101 phase=code',
        toolCall: { name: 'run_command', args: { CommandLine: 'bv gate-green' } }
      },
      tmpWorkspace
    );
    assert.strictEqual(blockedTool.decision, 'deny', 'Tool call in completed subagent session must be denied');
    assert.ok(blockedTool.reason.includes('SINGLE-EXIT LOCK'), 'Denial reason notes SINGLE-EXIT LOCK');
  });

  it('Planner Role & Plan Phase: allows plan packet write, denies source file edits', () => {
    const planConvId = 'subagent-planner-conv-102';
    const issueNum = 102;
    const planPacketRel = `.bv/packets/ISSUE-${issueNum}/plan.md`;
    const srcFileRel = 'apps/backend/src/big.service.ts';

    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ACTIVE_ISSUE'),
      JSON.stringify({
        issue: issueNum,
        activeConversationId: planConvId,
        phase: 'plan'
      }),
      'utf8'
    );
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', `ISSUE-${issueNum}.json`),
      JSON.stringify({
        issue: issueNum,
        id: 'ISSUE-102',
        branch: 'feature/issue-102',
        phase: 'plan',
        activeConversationId: planConvId,
        attempts: {}
      }),
      'utf8'
    );

    // Planner can write plan packet
    const planWrite = evaluatePreToolUse(
      {
        conversationId: planConvId,
        workspacePaths: [tmpWorkspace],
        lastUserInput: 'ISSUE-102 phase=plan',
        toolCall: { name: 'write_file', args: { Path: planPacketRel } }
      },
      tmpWorkspace
    );
    assert.strictEqual(planWrite.decision, 'allow', 'Planner is allowed to write plan.md');

    // Planner cannot edit source files
    const srcWrite = evaluatePreToolUse(
      {
        conversationId: planConvId,
        workspacePaths: [tmpWorkspace],
        lastUserInput: 'ISSUE-102 phase=plan',
        toolCall: { name: 'write_file', args: { Path: srcFileRel } }
      },
      tmpWorkspace
    );
    assert.strictEqual(srcWrite.decision, 'deny', 'Planner is forbidden from modifying source files');
  });

  it('Orchestrator Wakeup After Subagent Completion: root orchestrator is never blocked by PreInvocation after planner completes', () => {
    const orchConvId = '9e0d840d-dd19-4352-9637-dd0973c47081';
    const plannerConvId = 'e611ed0a-a02e-436a-8b05-2cfb8ee61f2c';
    const issueNum = 84;
    const planDir = join(tmpWorkspace, '.bv', 'packets', `ISSUE-${issueNum}`);
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.md'), '# PLAN Phase Packet: ISSUE-084\n', 'utf8');

    // Simulate state right after planner finished `bv post-comment plan` (even if orchestratorConversationId was not in initial ledger)
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', 'ACTIVE_ISSUE'),
      JSON.stringify({
        issue: issueNum,
        id: 'ISSUE-084',
        branch: 'feature/issue-084-user-feedback-session-3',
        phase: 'plan',
        activeConversationId: null
      }),
      'utf8'
    );
    writeFileSync(
      join(tmpWorkspace, '.bv', 'state', `ISSUE-${issueNum}.json`),
      JSON.stringify({
        issue: issueNum,
        id: 'ISSUE-084',
        branch: 'feature/issue-084-user-feedback-session-3',
        phase: 'plan',
        activeConversationId: null,
        comments: { plan: { postedAt: new Date().toISOString() } },
        completedPhases: { plan: { completedAt: new Date().toISOString(), conversationId: null } }
      }),
      'utf8'
    );

    // 1. Orchestrator invoked subagent (PostToolUse records orchestratorConversationId)
    evaluatePostToolUse(
      {
        conversationId: orchConvId,
        workspacePaths: [tmpWorkspace],
        lastUserInput: 'Orchestrate #84',
        toolCall: { name: 'invoke_subagent', args: { TypeName: 'planner' } }
      },
      tmpWorkspace
    );

    // 2. Planner subagent runs post-comment plan (PostToolUse records plannerConvId in activeConversationId & completedConversations)
    evaluatePostToolUse(
      {
        conversationId: plannerConvId,
        workspacePaths: [tmpWorkspace],
        lastUserInput: 'You are the `planner` subagent for GitHub Issue #84.',
        toolCall: { name: 'run_command', args: { CommandLine: 'bv post-comment plan' } }
      },
      tmpWorkspace
    );

    // 3. Planner subagent IS blocked from subsequent chat turns
    const subWakeup = evaluatePreInvocation(
      {
        conversationId: plannerConvId,
        workspacePaths: [tmpWorkspace],
        invocationNum: 15,
        lastUserInput: 'Another prompt to planner'
      },
      tmpWorkspace
    );
    assert.strictEqual(subWakeup.terminationBehavior, 'terminate', 'Completed planner subagent must be terminated on subsequent turns');

    // 4. Root orchestrator wakes up on subagent report message and MUST NOT be blocked
    const orchWakeup = evaluatePreInvocation(
      {
        conversationId: orchConvId,
        workspacePaths: [tmpWorkspace],
        invocationNum: 5,
        lastUserInput: '# Planner Phase Report: ISSUE-084 (#84)\nThe plan phase packet has been generated.'
      },
      tmpWorkspace
    );
    assert.deepStrictEqual(orchWakeup, {}, 'Root orchestrator wakeup must never be blocked after subagent completes phase');

    // 5. Root orchestrator can transition phase to red
    const orchSetPhase = evaluatePreToolUse(
      {
        conversationId: orchConvId,
        workspacePaths: [tmpWorkspace],
        lastUserInput: '# Planner Phase Report: ISSUE-084 (#84)',
        toolCall: { name: 'run_command', args: { CommandLine: 'bv set-phase red' } }
      },
      tmpWorkspace
    );
    assert.strictEqual(orchSetPhase.decision, 'allow', 'Root orchestrator is allowed to run bv set-phase red');
  });
});
