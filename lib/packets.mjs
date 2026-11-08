import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateRepoSlice } from './ast.mjs';

const MAX_PACKET_BYTES = 1950; // strictly <= 2 KB (2048 bytes)

function clampToBudget(text, maxBytes = MAX_PACKET_BYTES) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const sliced = buf.subarray(0, maxBytes - 60).toString('utf8');
  const lastNewline = sliced.lastIndexOf('\n');
  return (lastNewline > 200 ? sliced.slice(0, lastNewline) : sliced) + '\n...(truncated to <=2KB budget)\n';
}

export async function generatePhasePacket({ ctx, ledger, phase, issueData = null, extraNotes = '' }) {
  const issueNum = ledger.issue;
  const issueId = ledger.id || `ISSUE-${issueNum}`;
  const packetDir = join(ctx.bvDir, 'packets', `ISSUE-${issueNum}`);
  mkdirSync(packetDir, { recursive: true });

  // Load cached issue JSON if available
  let issue = issueData;
  if (!issue) {
    const issueJsonPath = join(ctx.bvDir, 'issues', `${issueNum}.json`);
    if (existsSync(issueJsonPath)) {
      try {
        issue = JSON.parse(readFileSync(issueJsonPath, 'utf8'));
      } catch {}
    }
  }

  const title = issue?.title || `${issueId}`;
  const acs = (issue?.acceptanceCriteria || []).slice(0, 8);
  const targetFiles = (issue?.targetFiles || []).slice(0, 8);

  let content = '';
  if (phase === 'plan') {
    let sliceBlock = '';
    if (targetFiles.length > 0) {
      const slice = await generateRepoSlice({ files: targetFiles, repoDir: ctx.codeDir });
      sliceBlock = slice.slices
        .slice(0, 4)
        .map(s => {
          const syms = s.symbols
            .slice(0, 3)
            .map(sym => `${sym.name}(L${sym.startLine}-L${sym.endLine})`)
            .join(', ');
          return `- \`${s.path}\`: ${syms || `${s.totalLines}L`}`;
        })
        .join('\n');
    }

    content = [
      `# PLAN Phase Packet: ${issueId} (#${issueNum})`,
      `**Title:** ${title}`,
      `**Phase:** \`plan\``,
      ``,
      `## Section 1: Black-Box Acceptance Criteria (AC-1..N)`,
      ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. [ ] ${ac}`) : [`1. [ ] Implement ${title}`]),
      ``,
      `## Section 2: White-Box Technical Blueprint`,
      `### Target Modules & Signatures`,
      sliceBlock || `- Run \`bv search <keyword>\` or \`bv outline <file>\` to discover affected components.`,
      `### Architectural Constraints`,
      `- Enforce strict TypeScript (zero \`any\`).`,
      `- Maintain deterministic SDLC boundaries.`,
      ``,
      `## Exit Action`,
      `Verify plan and execute: \`bv post-comment plan\``
    ].join('\n');
  } else if (phase === 'red') {
    const testScaffold = `verify-${issueId.toLowerCase()}.test.mjs`;
    let sliceBlock = '';
    if (targetFiles.length > 0) {
      const slice = await generateRepoSlice({ files: targetFiles, repoDir: ctx.codeDir });
      sliceBlock = slice.slices
        .slice(0, 4)
        .map(s => {
          const syms = s.symbols
            .slice(0, 3)
            .map(sym => `${sym.name}(L${sym.startLine}-L${sym.endLine})`)
            .join(', ');
          return `- \`${s.path}\`: ${syms || `${s.totalLines}L`}`;
        })
        .join('\n');
    }

    content = [
      `# RED Phase Packet: ${issueId} (#${issueNum})`,
      `**Title:** ${title}`,
      `**Scaffold Target:** \`${testScaffold}\` | **Plan SSOT:** \`.bv/packets/ISSUE-${issueNum}/plan.md\``,
      ``,
      `## Acceptance Criteria (Author failing assertions for each)`,
      ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. [ ] ${ac}`) : [`1. [ ] Verify ${title}`]),
      ``,
      `## Target Signatures & Slice`,
      sliceBlock || `- Run \`bv search <keyword>\` or \`bv outline <file>\` if needed.`,
      ``,
      `## Exit Action`,
      `Write failing test \`${testScaffold}\` and execute: \`bv write-red ${testScaffold}\``
    ].join('\n');
  } else if (phase === 'code') {
    const redTests = ledger.red?.tests || [`verify-${issueId.toLowerCase()}.test.mjs`];
    let sliceBlock = '';
    if (targetFiles.length > 0) {
      const slice = await generateRepoSlice({ files: targetFiles, repoDir: ctx.codeDir });
      sliceBlock = slice.slices
        .slice(0, 5)
        .map(s => {
          const syms = s.symbols
            .slice(0, 4)
            .map(sym => `${sym.name}(L${sym.startLine}-L${sym.endLine})`)
            .join(', ');
          return `- \`${s.path}\`: ${syms || `${s.totalLines}L`}`;
        })
        .join('\n');
    }

    content = [
      `# CODE Phase Packet: ${issueId} (#${issueNum})`,
      `**Branch:** \`${ledger.branch}\` | **Locked RED Tests:** \`${redTests.join(', ')}\` (DO NOT EDIT)`,
      `**Plan SSOT:** \`.bv/packets/ISSUE-${issueNum}/plan.md\``,
      ``,
      `## Acceptance Criteria`,
      ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. ${ac}`) : [`1. Implement ${title}`]),
      ``,
      `## Target AST Slice Pointers`,
      sliceBlock || `- Use \`bv outline <file>\` and \`read_file\` with \`StartLine\`/\`EndLine\` (<=200 lines).`,
      ...(extraNotes ? [``, `## Failure Trace / Remediation Notes`, extraNotes] : []),
      ``,
      `## Exit Sequence`,
      `1. \`bv lint-types\``,
      `2. \`bv check-scope\``,
      `3. \`bv gate-green ${redTests[0]}\``
    ].join('\n');
  } else {
    content = [
      `# ${phase.toUpperCase()} Phase Packet: ${issueId} (#${issueNum})`,
      `**Title:** ${title}`,
      `**Phase:** \`${phase}\``,
      ``,
      `## Acceptance Criteria`,
      ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. ${ac}`) : [`1. ${title}`]),
      ``,
      `## Target Files`,
      ...(targetFiles.length > 0 ? targetFiles.map(f => `- \`${f}\``) : [`- None specified`])
    ].join('\n');
  }

  const finalContent = clampToBudget(content);
  const packetPath = join(packetDir, `${phase}.md`);
  if (phase === 'plan' && ledger?.completedPhases?.plan && existsSync(packetPath)) {
    const existing = readFileSync(packetPath, 'utf8');
    return {
      packetPath,
      relPath: `.bv/packets/ISSUE-${issueNum}/${phase}.md`,
      bytes: Buffer.byteLength(existing, 'utf8'),
      content: existing
    };
  }
  writeFileSync(packetPath, finalContent, 'utf8');
  return {
    packetPath,
    relPath: `.bv/packets/ISSUE-${issueNum}/${phase}.md`,
    bytes: Buffer.byteLength(finalContent, 'utf8'),
    content: finalContent
  };
}
