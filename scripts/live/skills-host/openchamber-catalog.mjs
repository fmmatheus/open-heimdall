// Reproduces the OpenChamber catalog checks recorded in
// docs/validation/openheimdall-skills.md.
//
// Starts an isolated OpenChamber server from a temporary install of
// @openchamber/web, adds a local Git clone of this repository as a custom catalog
// source and drives the same HTTP routes the Settings -> Skills catalog uses:
// scan, install (personal and project scope, with a name conflict), then list.
//
// OpenChamber only accepts GitHub-style `owner/repo` shorthands and https:// or git@
// URLs as sources. The local clone is reached by rewriting the clone URL of a
// placeholder repository with Git's `url.<base>.insteadOf` setting, supplied through
// GIT_CONFIG_* environment variables for the server process only.
//
// Isolation: HOME, XDG_*, OPENCHAMBER_DATA_DIR and the OpenCode config directory are
// inside a temporary sandbox; the server listens on a random loopback port and manages
// its own OpenCode child (isolated the same way) with no credentials. Nothing outside
// the sandbox is written and no running OpenChamber or OpenCode instance is contacted.
//
// Usage:
//   node scripts/live/skills-host/openchamber-catalog.mjs --install-dir DIRECTORY --opencode BINARY \
//     [--repo DIRECTORY] [--branch NAME] [--json FILE] [--keep]
//
// DIRECTORY holds `node_modules/@openchamber/web`, for example created with
//   npm install @openchamber/web@2.1.0 --ignore-scripts --save-exact
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PLACEHOLDER_REPOSITORY = 'example/openheimdall';
const SKILL_IDS = ['openheimdall-monitor', 'openheimdall-resume', 'openheimdall-start'];

function parseArguments(argv) {
  const options = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep') options.keep = true;
    else if (['--install-dir', '--opencode', '--repo', '--branch', '--json'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options['install-dir']) throw new Error('--install-dir DIRECTORY is required');
  if (!options.opencode) throw new Error('--opencode BINARY is required');
  return options;
}

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

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
}).trim();

function listTree(root) {
  const entries = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) entries.push(`${relative} (symlink)`);
      else if (entry.isDirectory()) visit(full);
      else entries.push(relative);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return entries;
}

const options = parseArguments(process.argv.slice(2));
const webRoot = path.join(path.resolve(options['install-dir']), 'node_modules', '@openchamber', 'web');
const webVersion = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8')).version;
const repo = path.resolve(options.repo ?? git(process.cwd(), 'rev-parse', '--show-toplevel'));
const branch = options.branch ?? git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openheimdall-oc-host.')));
const hide = text => String(text).replaceAll(sandbox, '<sandbox>');
const observations = { openchamberVersion: webVersion, node: process.version, platform: `${os.platform()} ${os.arch()}`, branch };
let server;

try {
  // Local clone of the branch under test, standing in for the remote.
  const clone = path.join(sandbox, 'remote', 'openheimdall.git-clone');
  git(sandbox, 'clone', '--quiet', '--no-hardlinks', '--branch', branch, repo, clone);
  observations.cloneHead = git(clone, 'rev-parse', '--short', 'HEAD');
  observations.cloneSkillFiles = listTree(path.join(clone, 'skills'));

  const home = path.join(sandbox, 'home');
  const project = path.join(sandbox, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'Synthetic project for catalog installs.\n');
  git(project, 'init', '-q');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.');
  git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
  const personalSkills = path.join(home, '.config', 'opencode', 'skills');
  const projectSkills = path.join(project, '.opencode', 'skills');
  const env = {
    PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TMPDIR: path.join(sandbox, 'tmp'),
    OPENCHAMBER_DATA_DIR: path.join(sandbox, 'openchamber-data'),
    OPENCODE_BINARY: path.resolve(options.opencode),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${clone}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${PLACEHOLDER_REPOSITORY}.git`,
  };
  for (const directory of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR, env.OPENCHAMBER_DATA_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const port = await freePort();
  let log = '';
  server = spawn(process.execPath, [path.join(webRoot, 'bin', 'cli.js'), 'serve', '--foreground', '--host', '127.0.0.1', '--port', String(port), '--api-only'], {
    cwd: sandbox,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;

  async function request(method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json, text: json === undefined ? text.slice(0, 300) : undefined };
  }

  let health;
  for (let attempt = 0; attempt < 240 && !health; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`openchamber exited early (${server.exitCode}): ${hide(log.slice(-800))}`);
    try {
      const answer = await request('GET', '/health');
      if (answer.status === 200 && answer.json) health = answer.json;
    } catch {
      // not listening yet
    }
    if (!health) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!health) throw new Error(`openchamber did not answer /health: ${hide(log.slice(-800))}`);
  observations.health = health;

  const summarizeItems = items => (items ?? []).map(item => ({
    skillName: item.skillName,
    skillDir: item.skillDir,
    installable: item.installable,
    frontmatterName: item.frontmatterName,
    description: item.description,
    warnings: item.warnings,
  }));
  const source = PLACEHOLDER_REPOSITORY;
  const subpath = 'skills';

  const scan = await request('POST', '/api/config/skills/scan', { source, subpath });
  observations.scan = { status: scan.status, ok: scan.json?.ok, items: summarizeItems(scan.json?.items), error: scan.json?.error, text: scan.text };
  const selections = (scan.json?.items ?? []).filter(item => SKILL_IDS.includes(item.skillName)).map(item => ({ skillDir: item.skillDir }));

  const install = async (name, body, query = '') => {
    const answer = await request('POST', `/api/config/skills/install${query}`, { source, subpath, targetSource: 'opencode', selections, ...body });
    observations[name] = { status: answer.status, ok: answer.json?.ok, installed: answer.json?.installed, skipped: answer.json?.skipped, error: answer.json?.error, text: answer.text };
  };

  await install('installPersonal', { scope: 'user' });
  observations.personalTree = listTree(personalSkills);
  await install('installPersonalAgain', { scope: 'user' });
  await install('installPersonalSkipAll', { scope: 'user', conflictPolicy: 'skipAll' });
  await install('installProject', { scope: 'project' }, `?directory=${encodeURIComponent(project)}`);
  observations.projectTree = listTree(projectSkills);

  // Listing as the Settings -> Skills panel does, for the project directory.
  const listing = await request('GET', `/api/config/skills?directory=${encodeURIComponent(project)}`);
  observations.listing = {
    status: listing.status,
    openCodeSkillsUnavailable: listing.json?.openCodeSkillsUnavailable ?? false,
    skills: (listing.json?.skills ?? []).filter(skill => SKILL_IDS.includes(skill.name)).map(skill => ({
      name: skill.name,
      scope: skill.scope,
      source: skill.source,
      path: hide(skill.path),
      description: skill.description,
    })),
    otherSkills: (listing.json?.skills ?? []).filter(skill => !SKILL_IDS.includes(skill.name)).map(skill => skill.name),
  };
  const detail = await request('GET', `/api/config/skills/openheimdall-start?directory=${encodeURIComponent(project)}`);
  observations.detail = { status: detail.status, keys: detail.json ? Object.keys(detail.json) : undefined, sources: detail.json?.sources ? Object.keys(detail.json.sources) : undefined };
  observations.versionRoute = (await request('GET', '/api/version')).json;
  observations.serverLog = hide(log).split('\n').filter(line => /opencode|skill|error|warn/i.test(line)).slice(0, 25);
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.kill('SIGKILL'); }, 8000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (options.keep) observations.sandbox = sandbox;
  else fs.rmSync(sandbox, { recursive: true, force: true });
}

const text = JSON.stringify(observations, null, 2);
if (options.json) fs.writeFileSync(options.json, text + '\n');
process.stdout.write(text + '\n');
