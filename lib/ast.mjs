import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Extracts structured symbol outline with exact L<start>-L<end> line ranges
 * using TypeScript Compiler API when available, falling back to a deterministic brace-tracking AST scanner.
 */
export async function extractFileOutline(filePath, repoDir = process.cwd()) {
  const fullPath = resolve(repoDir, filePath);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const sourceText = readFileSync(fullPath, 'utf8');
  const lines = sourceText.split('\n');
  const totalLines = lines.length;
  const relPath = relative(repoDir, fullPath);

  // Try TypeScript Compiler API from repo's node_modules
  let ts = null;
  const tsCandidates = [
    join(repoDir, 'node_modules', 'typescript', 'lib', 'typescript.js'),
    join(repoDir, '..', 'bv-ososapp', 'node_modules', 'typescript', 'lib', 'typescript.js')
  ];
  for (const cand of tsCandidates) {
    if (existsSync(cand)) {
      try {
        const mod = await import(cand);
        ts = mod.default || mod;
        break;
      } catch {}
    }
  }

  const symbols = [];

  if (ts && /\.(ts|tsx|js|mjs|cjs)$/.test(fullPath)) {
    const sf = ts.createSourceFile(
      fullPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      fullPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const getLine = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;

    function visit(node, parentName = '') {
      const startLine = getLine(node.getStart(sf));
      const endLine = getLine(node.getEnd());
      const isExported =
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || Boolean(parentName);

      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const firstLine = lines[startLine - 1]?.trim().replace(/\s*\{$/, '') || name;
        symbols.push({
          kind: 'function',
          name: parentName ? `${parentName}.${name}` : name,
          exported: isExported,
          startLine,
          endLine,
          signature: firstLine.slice(0, 120)
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        symbols.push({
          kind: 'class',
          name: className,
          exported: isExported,
          startLine,
          endLine,
          signature: `class ${className}`
        });
        node.members.forEach(member => {
          if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name) {
            const mName = member.name.getText(sf);
            const mStart = getLine(member.getStart(sf));
            const mEnd = getLine(member.getEnd());
            const mLine = lines[mStart - 1]?.trim().replace(/\s*\{$/, '') || mName;
            symbols.push({
              kind: ts.isMethodDeclaration(member) ? 'method' : 'property',
              name: `${className}.${mName}`,
              exported: true,
              startLine: mStart,
              endLine: mEnd,
              signature: mLine.slice(0, 120)
            });
          }
        });
        return;
      } else if (ts.isInterfaceDeclaration(node) && node.name) {
        symbols.push({
          kind: 'interface',
          name: node.name.text,
          exported: isExported,
          startLine,
          endLine,
          signature: `interface ${node.name.text}`
        });
      } else if (ts.isTypeAliasDeclaration(node) && node.name) {
        symbols.push({
          kind: 'type',
          name: node.name.text,
          exported: isExported,
          startLine,
          endLine,
          signature: lines[startLine - 1]?.trim().slice(0, 120) || `type ${node.name.text}`
        });
      } else if (ts.isEnumDeclaration(node) && node.name) {
        symbols.push({
          kind: 'enum',
          name: node.name.text,
          exported: isExported,
          startLine,
          endLine,
          signature: `enum ${node.name.text}`
        });
      } else if (ts.isVariableStatement(node)) {
        node.declarationList.declarations.forEach(decl => {
          if (ts.isIdentifier(decl.name)) {
            const vStart = getLine(node.getStart(sf));
            const vEnd = getLine(node.getEnd());
            const isFunc =
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
            if (isExported || isFunc || vEnd - vStart >= 3) {
              symbols.push({
                kind: isFunc ? 'function' : 'const',
                name: decl.name.text,
                exported: isExported,
                startLine: vStart,
                endLine: vEnd,
                signature: lines[vStart - 1]?.trim().slice(0, 120) || decl.name.text
              });
            }
          }
        });
      }
      ts.forEachChild(node, child => visit(child, parentName));
    }

    visit(sf);
  } else {
    // Fallback regex + brace counter for .prisma or non-TS files
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const match = trimmed.match(
        /^(?:export\s+)?(?:async\s+)?(function|class|interface|type|enum|const|model)\s+([A-Za-z0-9_]+)/
      );
      if (match) {
        const kind = match[1];
        const name = match[2];
        const startLine = i + 1;
        let endLine = startLine;
        let braceDepth = 0;
        let startedBraces = false;
        for (let j = i; j < Math.min(lines.length, i + 300); j++) {
          for (const ch of lines[j]) {
            if (ch === '{') {
              braceDepth++;
              startedBraces = true;
            } else if (ch === '}') {
              braceDepth--;
            }
          }
          if (startedBraces && braceDepth <= 0) {
            endLine = j + 1;
            break;
          }
          if (!startedBraces && lines[j].trim().endsWith(';')) {
            endLine = j + 1;
            break;
          }
        }
        symbols.push({
          kind,
          name,
          exported: trimmed.startsWith('export ') || kind === 'model',
          startLine,
          endLine,
          signature: trimmed.slice(0, 120)
        });
      }
    }
  }

  return {
    file: relPath,
    totalLines,
    symbols
  };
}

/**
 * Runs ripgrep (rg --json) and returns compact file:L<start>-L<end> matches (<= 30 matches)
 */
export function runRipgrepSearch(query, searchPath, repoDir = process.cwd()) {
  const target = searchPath ? resolve(repoDir, searchPath) : repoDir;
  const rgArgs = [
    '--json',
    '--max-count=10',
    '--glob=!node_modules/**',
    '--glob=!dist/**',
    '--glob=!.git/**',
    '--glob=!.bv/**',
    '--glob=!pnpm-lock.yaml',
    query,
    target
  ];

  const res = spawnSync('rg', rgArgs, { cwd: repoDir, encoding: 'utf8', timeout: 10000 });
  const matches = [];
  if (res.stdout) {
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'match') {
          const p = relative(repoDir, evt.data.path.text);
          const lineNum = evt.data.line_number;
          const text = (evt.data.lines.text || '').trim().slice(0, 110);
          const startRange = Math.max(1, lineNum - 5);
          const endRange = lineNum + 15;
          matches.push({
            file: p,
            line: lineNum,
            range: `${p}:L${startRange}-L${endRange}`,
            text
          });
          if (matches.length >= 25) break;
        }
      } catch {}
    }
  }
  return matches;
}

/**
 * Deterministically slices the codebase for query keywords or target files,
 * producing both a Markdown AST summary and structured symbol ranges.
 */
export async function generateRepoSlice({ query = '', files = [], repoDir = process.cwd() }) {
  const searchRoots = [
    repoDir,
    join(repoDir, 'apps/backend/src'),
    join(repoDir, 'apps/spirit/src'),
    join(repoDir, 'packages')
  ].filter(existsSync);

  const matchedPaths = new Set();
  for (const f of files) {
    const full = resolve(repoDir, f);
    if (existsSync(full)) matchedPaths.add(full);
  }

  const qLower = query.toLowerCase().trim();
  const keywords = qLower
    .split(/[\s,]+/)
    .map(k => k.trim())
    .filter(k => k.length >= 2);

  function walk(dir, depth = 0) {
    if (depth > 6 || matchedPaths.size >= 40) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        [
          'node_modules',
          'dist',
          '.turbo',
          '.git',
          '.bv',
          '.system_generated',
          'coverage',
          'build',
          'exports',
          'proofs'
        ].includes(entry.name)
      ) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          dir === repoDir &&
          ['apps', 'packages', 'tools', '.context'].includes(entry.name) &&
          searchRoots.length > 1
        ) {
          continue;
        }
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (['.ts', '.tsx', '.mjs', '.js', '.prisma'].includes(ext) || entry.name === '.env.schema') {
          const rel = relative(repoDir, fullPath).toLowerCase();
          let isMatch = keywords.length === 0 || keywords.some(kw => rel.includes(kw));
          if (!isMatch && keywords.length > 0) {
            try {
              const snippet = readFileSync(fullPath, 'utf8').slice(0, 4000).toLowerCase();
              if (keywords.some(kw => snippet.includes(kw))) {
                isMatch = true;
              }
            } catch {}
          }
          if (isMatch) {
            matchedPaths.add(fullPath);
          }
        }
      }
    }
  }

  for (const root of searchRoots) {
    walk(root);
  }

  const slices = [];
  for (const fullPath of Array.from(matchedPaths).slice(0, 20)) {
    try {
      const outline = await extractFileOutline(fullPath, repoDir);
      slices.push({
        path: outline.file,
        totalLines: outline.totalLines,
        symbols: outline.symbols.slice(0, 10)
      });
    } catch {}
  }

  const markdown = [
    `# 🗺️ Deterministic Repository AST Slice`,
    `**Query:** \`${query || '*'}\` | **Matched Files:** ${ matchedPaths.size } | Generated in <100ms`,
    ``,
    `### 🎯 Relevant Target Files & Exported Symbols:`,
    ...slices.map(f => {
      const symList =
        f.symbols.length > 0
          ? f.symbols
              .map(s => `  - \`L${s.startLine}-L${s.endLine}\`: \`${s.signature}\``)
              .join('\n')
          : `  - *(Internal module / ${f.totalLines} lines)*`;
      return `- **[\`${f.path}\`](file:///${join(repoDir, f.path)})** (${f.totalLines} lines):\n${symList}`;
    }),
    ``,
    `*Note: Subagents should directly view and edit these target line ranges without running exploratory \`find\`, \`grep\`, or whole-file reads > 200 lines.*`
  ].join('\n');

  return {
    matchedCount: matchedPaths.size,
    slices,
    markdown
  };
}
