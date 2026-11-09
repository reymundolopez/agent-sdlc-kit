import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scanRegistrations, findShadowed } from '../lib/registrations.mjs';

const KIT = resolve(new URL('..', import.meta.url).pathname);
const BV = join(KIT, 'bin', 'bv');
const hooks = (cmdPath) => JSON.stringify({ 'agent-sdlc-kit': { SessionStart: [{ type: 'command', command: `node ${cmdPath}` }] } });
const tmp = () => mkdtempSync(join(tmpdir(), 'bv-reg-'));

function pluginWith(dir) {
  const plugins = join(dir, 'plugins');
  mkdirSync(plugins, { recursive: true });
  symlinkSync(KIT, join(plugins, 'agent-sdlc-kit'));
  return plugins;
}

describe('registration scanner', () => {
  it('single plugin registration passes', () => {
    const d = tmp();
    const regs = scanRegistrations({ roots: [d], pluginsDir: pluginWith(d) });
    assert.strictEqual(regs.length, 1);
  });

  it('detects duplicate via absolute-path project hooks', () => {
    const d = tmp();
    mkdirSync(join(d, '.agents'));
    writeFileSync(join(d, '.agents', 'hooks.json'), hooks(`${KIT}/scripts/hooks/session-start.mjs`));
    const regs = scanRegistrations({ roots: [d], pluginsDir: pluginWith(d) });
    assert.strictEqual(regs.length, 2);
  });

  it('detects duplicate via copied hooks with relative paths', () => {
    const d = tmp();
    mkdirSync(join(d, '.agents'));
    writeFileSync(join(d, '.agents', 'hooks.json'), hooks('./scripts/hooks/session-start.mjs'));
    assert.strictEqual(scanRegistrations({ roots: [d], pluginsDir: pluginWith(d) }).length, 2);
  });

  it('collapses symlinked hooks file to one registration', () => {
    const d = tmp();
    mkdirSync(join(d, '.agents'));
    symlinkSync(join(KIT, 'hooks.json'), join(d, '.agents', 'hooks.json'));
    assert.strictEqual(scanRegistrations({ roots: [d], pluginsDir: pluginWith(d) }).length, 1);
  });

  it('flags shadowed agents/skills', () => {
    const d = tmp();
    mkdirSync(join(d, '.agents', 'agents'), { recursive: true });
    writeFileSync(join(d, '.agents', 'agents', 'planner.md'), 'x');
    assert.deepStrictEqual(findShadowed([d], KIT), [join('.agents', 'agents', 'planner.md')]);
  });
});

describe('bv init', () => {
  const run = (cwd, ...args) => spawnSync('node', [BV, 'init', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BV_HOOKS: 'off' } });

  it('creates project-owned files, is idempotent, never overwrites config', () => {
    const d = tmp();
    const r1 = run(d);
    assert.strictEqual(r1.status, 0, r1.stdout + r1.stderr);
    assert.match(r1.stdout, /Initialized agent-sdlc-kit/);
    for (const p of ['.agents/sdlc.config.json', '.bv/state', '.bv/packets', '.bv/logs']) assert.ok(existsSync(join(d, p)), p);
    assert.ok(!existsSync(join(d, '.agents', 'hooks.json')));
    assert.match(readFileSync(join(d, '.gitignore'), 'utf8'), /^\.bv\/$/m);
    writeFileSync(join(d, '.agents', 'sdlc.config.json'), '{"custom":true}');
    const r2 = run(d);
    assert.strictEqual(r2.status, 0);
    assert.match(r2.stdout, /Already initialized \(0 files changed\)/);
    assert.strictEqual(readFileSync(join(d, '.agents', 'sdlc.config.json'), 'utf8'), '{"custom":true}');
    run(d, '--force');
    assert.notStrictEqual(readFileSync(join(d, '.agents', 'sdlc.config.json'), 'utf8'), '{"custom":true}');
  });

  it('refuses when local kit hooks exist unless --allow-local-hooks', () => {
    const d = tmp();
    mkdirSync(join(d, '.agents'));
    writeFileSync(join(d, '.agents', 'hooks.json'), hooks(`${KIT}/scripts/hooks/session-start.mjs`));
    const r = run(d);
    assert.strictEqual(r.status, 4);
    assert.match(r.stdout, /Refusing to init/);
    assert.strictEqual(run(d, '--allow-local-hooks').status, 0);
  });
});

describe('bv doctor --fix', () => {
  const runDoctor = (cwd, pluginsDir, ...args) => spawnSync('node', [BV, 'doctor', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BV_HOOKS: 'off', BV_PLUGINS_DIR: pluginsDir }
  });

  it('prunes duplicate project hooks and shadowed files when --fix is passed', () => {
    const d = tmp();
    const pluginsDir = pluginWith(d);
    mkdirSync(join(d, '.agents', 'skills', 'orchestrate-issue'), { recursive: true });
    writeFileSync(join(d, '.agents', 'skills', 'orchestrate-issue', 'SKILL.md'), 'shadow');
    writeFileSync(join(d, '.agents', 'hooks.json'), hooks(`${KIT}/scripts/hooks/session-start.mjs`));

    // Without --fix: doctor fails due to duplicate hooks
    const r1 = runDoctor(d, pluginsDir);
    assert.strictEqual(r1.status, 2);
    assert.match(r1.stdout, /Kit registered 2 times/);

    // With --fix: cleans up duplicate project hook and shadowed files
    const r2 = runDoctor(d, pluginsDir, '--fix');
    assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
    assert.ok(!existsSync(join(d, '.agents', 'hooks.json')));
    assert.ok(!existsSync(join(d, '.agents', 'skills', 'orchestrate-issue')));
  });
});
