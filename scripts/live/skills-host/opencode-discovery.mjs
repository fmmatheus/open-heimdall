// Reproduces the OpenCode skill-discovery checks recorded in
// docs/validation/openheimdall-skills.md.
//
// Installs the skills from a packed OpenHeimdall tarball with the copy procedure
// documented in docs/skills.md, then asks a private `opencode serve` instance which
// skills it discovered. The query is `GET /api/skill`, which does not call a model.
//
// Isolation: every OpenCode process gets a scrubbed environment with HOME,
// XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME and XDG_STATE_HOME inside a
// temporary sandbox, no credentials, and a random loopback port. OPENCODE_CONFIG_DIR
// is set only for the custom-directory scenario. Nothing outside the sandbox is
// written, and the background OpenCode service is never contacted.
//
// Usage:
//   node scripts/live/skills-host/opencode-discovery.mjs --tarball FILE [--opencode BINARY] [--json FILE] [--keep]
//
// Create the tarball with `npm run pack:clean -- --out DIRECTORY`.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SKILL_IDS = ['openheimdall-start', 'openheimdall-monitor', 'openheimdall-resume'];

function parseArguments(argv) {
  const options = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep') options.keep = true;
    else if (['--tarball', '--opencode', '--json'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.tarball) throw new Error('--tarball FILE is required');
  return options;
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The copy loop from docs/skills.md ("Personal install" and "Project install").
const COPY_LOOP = `
mkdir -p "$TARGET"
for name in openheimdall-start openheimdall-monitor openheimdall-resume; do
  if [ -e "$TARGET/$name" ] || [ -L "$TARGET/$name" ]; then
    echo "skip: $TARGET/$name already exists" >&2
  else
    cp -R "$SKILLS/$name" "$TARGET/$name"
  fi
done
`;

// Runs the copy loop and keeps its stderr, which carries the "skip:" refusal lines.
function copySkills(skills, target) {
  const result = spawnSync('sh', ['-c', COPY_LOOP], {
    env: { PATH: '/usr/bin:/bin', SKILLS: skills, TARGET: target },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`copy exited ${result.status}: ${result.stderr}`);
  return { target: target.replace(path.dirname(path.dirname(skills)), '<sandbox>'), skipped: result.stderr.trim().split('\n').filter(Boolean) };
}

function isolatedEnvironment(sandbox, name, customConfigDirectory) {
  const home = path.join(sandbox, name, 'home');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TMPDIR: path.join(sandbox, name, 'tmp'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  for (const directory of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (customConfigDirectory) env.OPENCODE_CONFIG_DIR = customConfigDirectory;
  return env;
}

// `opencode serve` protects the API with HTTP basic auth (user `opencode`) and prints
// a generated password when it starts listening.
async function waitForServer(base, child, output) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`opencode serve exited early (${child.exitCode})`);
    const password = /server password (\S+)/.exec(output())?.[1];
    if (password) {
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
      try {
        const response = await fetch(`${base}/api/info`, { headers });
        if (response.ok) return { info: await response.json(), headers };
      } catch {
        // not listening yet
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('opencode serve did not answer /api/info');
}

async function listSkills({ opencode, env, cwd, projectDirectory }) {
  const port = await freePort();
  const child = spawn(opencode, ['--print-logs', '--log-level', 'debug', 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const { info, headers } = await waitForServer(base, child, () => output);
    const url = `${base}/api/skill?location[directory]=${encodeURIComponent(projectDirectory)}`;
    // Skill sources load asynchronously after the first request for a location, so the
    // first answers can be empty. Poll until the listing is non-empty and unchanged.
    let listing;
    let previous;
    let stable = 0;
    for (let attempt = 0; attempt < 120 && stable < 4; attempt += 1) {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`GET /api/skill answered ${response.status}: ${await response.text()}`);
      listing = await response.json();
      const key = JSON.stringify(listing.data.map(skill => skill.id).sort());
      stable = listing.data.length > 0 && key === previous ? stable + 1 : 0;
      previous = key;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (stable < 4) throw new Error('GET /api/skill did not return a stable, non-empty listing');
    const sources = [...output.matchAll(/message="skill source loaded" source=(\S+) .*? skills=(\S.*)$/gm)]
      .map(match => ({ source: match[1], skills: match[2] }));
    return { info, listing, sources };
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve();
      else {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      }
    });
  }
}

function summarize(listing, sandbox, reference) {
  const skills = listing.data
    .filter(skill => skill.id.startsWith('openheimdall-'))
    .map(skill => {
      const skillFile = skill.path;
      const packed = reference.get(skill.id);
      return {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        autoinvoke: skill.autoinvoke,
        path: skillFile.replace(sandbox, '<sandbox>'),
        baseDirectory: path.dirname(skillFile).replace(sandbox, '<sandbox>'),
        helperPresent: fs.existsSync(path.join(path.dirname(skillFile), 'scripts', 'openheimdall.mjs')),
        contentBytes: Buffer.byteLength(skill.content),
        contentSha256: sha256(skill.content).slice(0, 16),
        contentIsPackedBody: packed ? packed.body === skill.content.trim() : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { total: listing.data.length, openheimdall: skills };
}

function readPackedReference(skillsRoot) {
  const reference = new Map();
  for (const id of SKILL_IDS) {
    const text = fs.readFileSync(path.join(skillsRoot, id, 'SKILL.md'), 'utf8');
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
    reference.set(id, { body, description, sha256: sha256(text).slice(0, 16) });
  }
  return reference;
}

function git(directory, ...args) {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: directory } });
}

function makeProject(sandbox, name) {
  const project = path.join(sandbox, name, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'Synthetic project for skill discovery.\n');
  git(project, 'init', '-q');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
  return project;
}

const options = parseArguments(process.argv.slice(2));
const opencode = options.opencode ?? execFileSync('/usr/bin/which', ['opencode'], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
const version = execFileSync(opencode, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() } }).trim();

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openheimdall-skills-host.')));
const observations = { opencodeVersion: version, node: process.version, platform: `${os.platform()} ${os.arch()}`, scenarios: {} };

try {
  fs.mkdirSync(path.join(sandbox, 'package'));
  execFileSync('tar', ['-xzf', path.resolve(options.tarball), '-C', path.join(sandbox, 'package')], { stdio: 'ignore' });
  const skills = path.join(sandbox, 'package', 'package', 'skills');
  observations.packedSkillDirectories = fs.readdirSync(skills).sort();
  const reference = readPackedReference(skills);

  async function scenario(name, prepare, customConfigDirectory) {
    const env = isolatedEnvironment(sandbox, name, customConfigDirectory);
    const project = makeProject(sandbox, name);
    const copies = prepare({ env, project });
    const result = await listSkills({ opencode, env, cwd: project, projectDirectory: project });
    const hide = text => text.replaceAll(sandbox, '<sandbox>').replaceAll(fs.realpathSync(os.tmpdir()), '<tmp>');
    observations.scenarios[name] = {
      copies,
      ...summarize(result.listing, sandbox, reference),
      otherSkillIds: result.listing.data.map(skill => skill.id).filter(id => !id.startsWith('openheimdall-')).sort(),
      location: hide(result.listing.location.directory),
      skillSources: result.sources
        .map(entry => ({ source: hide(entry.source), skills: entry.skills.replaceAll('\\"', '"').replace(/^"|"$/g, '') }))
        .filter(entry => entry.skills !== '[]'),
    };
    return { env, project, result };
  }

  await scenario('baseline-none', () => []);
  await scenario('personal', ({ env }) => [copySkills(skills, path.join(env.XDG_CONFIG_HOME, 'opencode', 'skills'))]);
  await scenario('project', ({ project }) => [copySkills(skills, path.join(project, '.opencode', 'skills'))]);
  const customDirectory = path.join(sandbox, 'custom-config');
  await scenario('custom-config-dir', () => [copySkills(skills, path.join(customDirectory, 'skills'))], customDirectory);

  // A pre-existing user skill with the same ID as one of the bundle skills.
  const conflictRun = await scenario('existing-name-conflict', ({ env }) => {
    const target = path.join(env.XDG_CONFIG_HOME, 'opencode', 'skills');
    const existing = path.join(target, 'openheimdall-start');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'SKILL.md'), '---\ndescription: Pre-existing user skill, not from the package.\n---\n\nPRE-EXISTING-MARKER\n');
    return [copySkills(skills, target)];
  });
  const preserved = fs.readFileSync(path.join(conflictRun.env.XDG_CONFIG_HOME, 'opencode', 'skills', 'openheimdall-start', 'SKILL.md'), 'utf8');
  observations.scenarios['existing-name-conflict'].existingFileKept = preserved.includes('PRE-EXISTING-MARKER');
  observations.scenarios['existing-name-conflict'].existingDirectoryHasHelper = fs.existsSync(path.join(conflictRun.env.XDG_CONFIG_HOME, 'opencode', 'skills', 'openheimdall-start', 'scripts'));

  // The same ID in the personal and the project scope: which copy is loaded.
  await scenario('personal-and-project-same-id', ({ env, project }) => {
    const personal = path.join(env.XDG_CONFIG_HOME, 'opencode', 'skills', 'openheimdall-start');
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, 'SKILL.md'), '---\ndescription: Stale personal copy.\n---\n\nPERSONAL-MARKER\n');
    return [copySkills(skills, path.join(project, '.opencode', 'skills'))];
  });
} finally {
  if (options.keep) observations.sandbox = sandbox;
  else fs.rmSync(sandbox, { recursive: true, force: true });
}

const text = JSON.stringify(observations, null, 2);
if (options.json) fs.writeFileSync(options.json, text + '\n');
process.stdout.write(text + '\n');
