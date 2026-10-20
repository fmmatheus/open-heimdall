import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = path.join(root, 'skills');
const expectedSkills = ['openheimdall-monitor', 'openheimdall-resume', 'openheimdall-start'];
const helperRelative = path.join('scripts', 'openheimdall.mjs');
const nameRule = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const allowedFrontmatterKeys = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const requiredSections = ['When to use', 'Procedure', 'Rules', 'Report'];

/**
 * Minimal YAML subset: top-level `key: value` pairs with plain or quoted single-line scalars, plus one level of
 * nested `key: value` pairs under a key with an empty value. Anything else is a parse error.
 */
export function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  assert.ok(match, 'SKILL.md must start with a frontmatter block');
  const data = {};
  let nested = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const entry = /^( *)([A-Za-z][A-Za-z0-9_-]*):(?: +(.*))?$/.exec(line);
    assert.ok(entry, `unsupported frontmatter line: ${line}`);
    const [, indent, key, raw = ''] = entry;
    const value = scalar(raw.trim());
    if (indent.length === 0) {
      assert.ok(!(key in data), `duplicate frontmatter key: ${key}`);
      data[key] = value;
      nested = value === '' ? (data[key] = {}) : null;
    } else {
      assert.ok(nested, `indented frontmatter line without a parent key: ${line}`);
      nested[key] = value;
    }
  }
  return { data, body: source.slice(match[0].length) };
}

function scalar(raw) {
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0];
    assert.ok(raw.length >= 2 && raw.endsWith(quote), `unterminated quoted scalar: ${raw}`);
    return raw.slice(1, -1);
  }
  assert.ok(!/^[|>\[{&*!%@`]/.test(raw), `unsupported YAML scalar: ${raw}`);
  assert.ok(!/ #/.test(raw), `comment inside a plain scalar: ${raw}`);
  return raw;
}

function walk(directory) {
  const found = [];
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    const stats = fs.lstatSync(full);
    found.push({ full, stats });
    if (stats.isDirectory()) found.push(...walk(full));
  }
  return found;
}

function sections(body) {
  const result = new Map();
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      result.set(current, []);
    } else if (current !== null) result.get(current).push(line);
  }
  return new Map([...result].map(([name, lines]) => [name, lines.join('\n')]));
}

const loaded = new Map();
for (const name of expectedSkills) {
  const file = path.join(skillsRoot, name, 'SKILL.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  loaded.set(name, { file, text, ...(text ? parseFrontmatter(text) : { data: {}, body: '' }) });
}

test('the bundle contains exactly the three expected skill directories', () => {
  const entries = fs.readdirSync(skillsRoot).sort();
  assert.deepEqual(entries, expectedSkills);
});

test('no symlinks exist anywhere under skills/', () => {
  const links = walk(skillsRoot).filter(({ stats }) => stats.isSymbolicLink()).map(({ full }) => path.relative(root, full));
  assert.deepEqual(links, []);
  assert.ok(!fs.lstatSync(skillsRoot).isSymbolicLink());
});

test('each skill directory contains exactly SKILL.md and scripts/openheimdall.mjs as regular files', () => {
  for (const name of expectedSkills) {
    const directory = path.join(skillsRoot, name);
    const files = walk(directory).filter(({ stats }) => !stats.isDirectory());
    for (const { full, stats } of files) assert.ok(stats.isFile(), `${full} must be a regular file`);
    assert.deepEqual(files.map(({ full }) => path.relative(directory, full)).sort(), [helperRelative, 'SKILL.md'].sort(), name);
    const directories = walk(directory).filter(({ stats }) => stats.isDirectory()).map(({ full }) => path.relative(directory, full));
    assert.deepEqual(directories, ['scripts'], name);
  }
});

test('the three helper copies are identical', () => {
  const copies = expectedSkills.map(name => fs.readFileSync(path.join(skillsRoot, name, helperRelative)));
  assert.ok(copies[0].length > 0);
  for (const copy of copies.slice(1)) assert.ok(copy.equals(copies[0]), 'helper copies differ');
});

test('frontmatter names are unique, equal the directory name and follow the portable name rule', () => {
  const names = new Set();
  for (const name of expectedSkills) {
    const { data } = loaded.get(name);
    assert.equal(data.name, name, `${name}: frontmatter name must equal the directory name`);
    assert.match(data.name, nameRule);
    assert.ok(data.name.length <= 64);
    assert.ok(!names.has(data.name), `duplicate skill name ${data.name}`);
    names.add(data.name);
  }
  assert.equal(names.size, expectedSkills.length);
});

test('frontmatter has only portable keys and a precise description of at most 1024 characters', () => {
  for (const name of expectedSkills) {
    const { data } = loaded.get(name);
    for (const key of Object.keys(data)) assert.ok(allowedFrontmatterKeys.has(key), `${name}: unexpected frontmatter key ${key}`);
    assert.equal(typeof data.description, 'string');
    assert.ok(data.description.length >= 100, `${name}: description is too short to say when to use the skill`);
    assert.ok(data.description.length <= 1024, `${name}: description is ${data.description.length} characters`);
    assert.ok(!/[\r\n]/.test(data.description));
    assert.match(data.description, /\bUse when\b/, `${name}: description must say when to use the skill`);
    assert.match(data.description, /\bDo not use\b/, `${name}: description must say when not to use the skill`);
  }
});

test('descriptions separate start, monitor and resume', () => {
  assert.match(loaded.get('openheimdall-start').data.description, /task-spec Markdown file/);
  assert.match(loaded.get('openheimdall-monitor').data.description, /\bread-only\b/i);
  assert.match(loaded.get('openheimdall-monitor').data.description, /finite watch/);
  assert.match(loaded.get('openheimdall-resume').data.description, /same paused/);
  assert.match(loaded.get('openheimdall-resume').data.description, /guidance/);
});

test('each SKILL.md has the required procedural sections', () => {
  for (const name of expectedSkills) {
    const found = sections(loaded.get(name).body);
    for (const section of requiredSections) assert.ok(found.has(section), `${name}: missing section "${section}"`);
    assert.match(found.get('Procedure'), /^1\. /m, `${name}: Procedure must be a numbered list`);
    assert.match(found.get('Report'), /^```/m, `${name}: Report must give a fixed template`);
    assert.match(found.get('Report'), /Run:/);
    assert.match(found.get('Report'), /Evidence limits:/);
    assert.match(found.get('Report'), /Blocker \/ next action:/);
    assert.match(found.get('Report'), /Worktree \/ session:/);
  }
  assert.ok(sections(loaded.get('openheimdall-monitor').body).has('Prohibitions'));
  assert.match(sections(loaded.get('openheimdall-start').body).get('Report'), /Project:[\s\S]*Base:/);
});

test('the shared operating contract is stated in every skill', () => {
  for (const name of expectedSkills) {
    const { body } = loaded.get(name);
    assert.match(body, /Do not use the legacy `adr` workflow tool/, name);
    assert.match(body, /grant no permissions/, name);
    assert.match(body, /Never (?:install|run an installer)/, name);
    assert.match(body, /Base directory for this skill/, name);
    assert.match(body, /--cwd/, name);
    assert.match(body, /--coordinator-config/, name);
    assert.match(body, /same value on every call/, name);
  }
  for (const name of ['openheimdall-start', 'openheimdall-resume']) {
    const { body } = loaded.get(name);
    assert.match(body, /Never repeat `(?:start|resume)` automatically/, name);
    assert.match(body, /Do not ask for routine confirmation/, name);
  }
  const resume = loaded.get('openheimdall-resume').body;
  assert.match(resume, /--guidance-file/);
  assert.match(resume, /--guidance-stdin/);
  assert.match(resume, /Never submit a fresh run/);
  assert.match(resume, /never repeat `respond` automatically/);
  assert.match(resume, /--feedback-file/);
  assert.match(resume, /Only explicit words decide/);
  assert.match(resume, /never translate a generic "resume" or "continue" into approval/);
  assert.match(resume, /owner supplies decisions and access, never implementation chores/i);
  assert.match(resume, /file-writing tool/);
  const start = loaded.get('openheimdall-start').body;
  assert.match(start, /inspect-spec/);
  assert.match(start, /full commit/);
  assert.match(start, /--start-coordinator/);
});

test('every SKILL.md references only files inside its own directory', () => {
  for (const name of expectedSkills) {
    const { text } = loaded.get(name);
    const directory = path.join(skillsRoot, name);
    assert.ok(!/\.\.\//.test(text), `${name}: parent-directory reference`);
    assert.ok(!/\b(?:skills|docs|src|dist|examples|prompts|test)\/[\w.-]/.test(text), `${name}: reference to repository paths outside the skill`);
    assert.ok(!/(?:^|[\s("'`])\/(?:Users|home|tmp|opt|usr|etc|var)\//m.test(text), `${name}: absolute path`);
    const targets = new Set();
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) targets.add(match[1]);
    for (const match of text.matchAll(/(?<![\w./-])((?:\.\/)?(?:scripts|references|assets)\/[\w.-]+(?:\/[\w.-]+)*)/g)) targets.add(match[1]);
    assert.ok([...targets].some(target => target.endsWith('openheimdall.mjs')), `${name}: must name the helper`);
    for (const target of targets) {
      assert.ok(!/^[a-z]+:/i.test(target), `${name}: external link ${target}`);
      const resolved = path.resolve(directory, target);
      assert.ok(resolved.startsWith(directory + path.sep), `${name}: ${target} leaves the skill directory`);
      assert.ok(fs.existsSync(resolved), `${name}: ${target} does not exist`);
    }
  }
});

test('every helper subcommand and option named in a SKILL.md exists in the helper', () => {
  const helper = fs.readFileSync(path.join(skillsRoot, 'openheimdall-start', helperRelative), 'utf8');
  const commands = new Map([
    ['openheimdall-start', ['inspect-spec', 'context', 'start']],
    ['openheimdall-monitor', ['snapshot', 'watch', 'context']],
    ['openheimdall-resume', ['snapshot', 'resume', 'respond']],
  ]);
  for (const name of expectedSkills) {
    const { body } = loaded.get(name);
    for (const command of commands.get(name)) {
      assert.match(body, new RegExp(`\`${command}[ \`]`), `${name}: does not describe the ${command} command`);
      assert.match(helper, new RegExp(`openheimdall\\.mjs ${command}\\b`), `${command} is not a helper command`);
    }
    for (const option of new Set(body.match(/--[a-z][a-z-]*/g) ?? [])) {
      assert.ok(helper.includes(option) || option === '--json', `${name}: ${option} is not an option the helper accepts`);
    }
  }
});

test('the monitor skill names no state-changing command outside its prohibitions', () => {
  const { text } = loaded.get('openheimdall-monitor');
  const found = sections(parseFrontmatter(text).body);
  const outside = text.replace(/^## Prohibitions[\s\S]*?(?=^## |(?![\s\S]))/m, '');
  assert.ok(outside.length < text.length, 'Prohibitions section not removed');
  const mutating = [
    /\bsubmit\b/i, /\breconcile\b/i, /\bproject add\b/i, /\bregister\b/i,
    /\brun (?:resume|submit)\b/i, /\bcoordinator (?:start|stop)\b/i, /\bheimdall (?:start|stop)\b/i,
    /openheimdall\.mjs"? +(?:start|resume|inspect-spec)\b/, /`(?:start|resume)(?: |`)/,
    /--(?:register|start-coordinator|guidance-file|guidance-stdin|input)\b/,
    /\brespond\b/i, /--(?:request|decision|pause|feedback-file|feedback-stdin)\b/,
  ];
  for (const pattern of mutating) assert.ok(!pattern.test(outside), `monitor SKILL.md mentions ${pattern} outside Prohibitions`);
  const prohibitions = found.get('Prohibitions');
  for (const word of ['run submit', 'run resume', 'run respond', 'run reconcile', 'project add', 'start', 'stop', 'respond']) {
    assert.ok(prohibitions.includes(word), `Prohibitions should forbid ${word}`);
  }
  assert.match(prohibitions, /never changes anything/i);
});

test('start and resume skills do not name commands the helper must never run', () => {
  for (const name of ['openheimdall-start', 'openheimdall-resume']) {
    const { body } = loaded.get(name);
    for (const line of body.split(/\r?\n/).filter(text => /\brun reconcile\b/.test(text))) {
      assert.match(line, /\b(?:Do not|Never|never|not)\b/, `${name}: run reconcile appears outside a prohibition: ${line}`);
    }
  }
});

test('the helper command template single-quotes every value and states the escaping rule', () => {
  for (const name of expectedSkills) {
    const { body } = loaded.get(name);
    assert.match(body, /node '<skill directory>\/scripts\/openheimdall\.mjs' <command> --cwd '<working directory>'/, `${name}: template is not single-quoted`);
    assert.ok(!/"<[^">]*>"/.test(body), `${name}: a placeholder is double-quoted, so the shell would expand $(...) or backticks in it`);
    assert.ok(body.includes("'\\''"), `${name}: does not give the single-quote escape '\\''`);
    assert.match(body, /ask the user to rename/i, `${name}: no fallback for values that cannot be quoted`);
    assert.match(body, /single quotes/i, name);
  }
  assert.match(loaded.get('openheimdall-start').body, /file paths as separate single-quoted arguments/);
});

test('single-quoting a value as the skills document it keeps shell syntax literal', { skip: process.platform === 'win32' }, async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const os = await import('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-quote-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const specification = path.join(directory, "spec $(echo INJECTED) `echo INJECTED` it's \"q\".md");
  fs.writeFileSync(specification, '# Feature\n\nDo it.\n');
  const helper = path.join(skillsRoot, 'openheimdall-start', helperRelative);
  const command = `node ${quote(helper)} inspect-spec ${quote(specification)} --cwd ${quote(directory)}`;
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command]);
  const report = JSON.parse(stdout);
  assert.equal(report.usable, true, stdout);
  assert.ok(!stdout.includes('INJECTED') || stdout.includes('$(echo INJECTED)'), 'the shell expanded text inside the quoted value');
});

test('the monitor skill allows reads only through the helper, with the same coordinator selection', () => {
  const { body } = loaded.get('openheimdall-monitor');
  assert.ok(!/heimdall (?:coordinator )?(?:run show|status)/.test(body), 'plain CLI reads would print whole run records and skip --coordinator-config');
});

test('the resume skill writes guidance to a uniquely named file and removes it afterwards', () => {
  const { body } = loaded.get('openheimdall-resume');
  assert.match(body, /unique(?:ly named)? (?:file )?name|new, uniquely named file/i);
  assert.match(body, /(?:remove|delete) (?:that|the) (?:temporary )?file/i);
  assert.match(body, /may be sensitive/i);
});

test('the monitor skill reports the approval wait read-only and sends the owner to the resume skill', () => {
  const { body, data } = loaded.get('openheimdall-monitor');
  assert.match(data.description, /pending approval request/);
  assert.match(data.description, /never answers it/);
  for (const field of ['run.wait', 'requestId', 'question', 'scope', 'onApprove', 'onRequestChanges', 'revision', 'pauseId', 'waitReported']) assert.ok(body.includes(field), `monitor SKILL.md does not describe ${field}`);
  assert.match(body, /Waiting for:/);
  const prohibitions = sections(body).get('Prohibitions');
  assert.match(prohibitions, /`respond`/);
  assert.match(prohibitions, /never record an approval/);
  assert.match(prohibitions, /`openheimdall-resume`/);
});

test('the resume skill transports only explicit owner decisions and keeps the agent responsible for the work', () => {
  const { body, data } = loaded.get('openheimdall-resume');
  assert.match(data.description, /explicit approval or requested changes/);
  assert.match(data.description, /plain resume or continue request into an approval/);
  for (const command of ['respond RUN_ID --request REQUEST_ID --decision approve', 'respond RUN_ID --request REQUEST_ID --decision request-changes', 'respond RUN_ID --pause PAUSE_ID']) assert.ok(body.includes(command), command);
  assert.match(body, /Only explicit words decide/);
  assert.match(body, /Never choose a decision for the owner/);
  assert.match(body, /never use `resume` or guidance to answer a request/);
  assert.match(body, /does not complete any gate/);
  assert.match(body, /agent corrects its work and submits a fresh request/);
  assert.match(body, /Never put credentials or private configuration/);
  assert.match(body, /Do not ask the owner to edit files, run commands or migrate data/);
  for (const outcome of ['queued', 'waiting-for-idle', 'recorded', 'refused', 'uncertain']) assert.ok(body.includes(`\`${outcome}\``), outcome);
  assert.match(body, /Never work around an unsupported or refusing coordinator/);
});
