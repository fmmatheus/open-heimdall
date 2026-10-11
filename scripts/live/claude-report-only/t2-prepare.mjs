// T2 fixture preparation: copies the built dist/ into the fixture root, applies the fixture-only settings, writes the
// fixture plugins, agents, MCP server and OpenCode config, and creates the recovery repository.
// Starts nothing and calls no model.
//   node t2-prepare.mjs --root /private/tmp/heimdall-0006.XXXXXX --port 4731 [--variant high] [--planner-model claude-code/opus] [--dist <built dist/>]
//
// Fixture-only settings (never applied to src/ or the repository's dist/):
//   F1 dist/opencode/report-only.js: VERIFIED_REPORT_ONLY_PROVIDERS must be ['claude-code']; the historical empty list is rewritten,
//      the final list is kept, any other value is rejected (provider-list.mjs)
//   F2 the fixture wrapper plugin passes createPlugin({ quota }) (the documented harness seam), a synthetic healthy
//      claude-code snapshot. The real probe execs the absolute /usr/bin/security, which the guard denies on purpose; quota
//      is not what this verification proves. dist/ itself is NOT modified for it, so the built plugin runs byte-identical.
//   F3 a wrapper plugin (createPlugin({ reportOnly: createReportOnlyRegistry(), quota })) with an owner-only control socket,
//      and two observers around it that only record
//   F4 a disposable stdio MCP server writing a marker file
// Plus the provider isolation patches already recorded by T1 (copy-provider.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFixtureRoot, emit, hashTree, parseArguments, readManifest, sha256, updateManifest } from './lib.mjs';
import { prepareProviderList } from './provider-list.mjs';
import { createRepository } from './repo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 57123) throw new Error('Provide a free --port (not the live server port)');
const variant = typeof options.variant === 'string' ? options.variant : undefined;
const plannerModel = typeof options['planner-model'] === 'string' ? options['planner-model'] : 'claude-code/sonnet';
if (!/^claude-code\/[a-z0-9.-]+$/.test(plannerModel)) throw new Error('--planner-model must be a claude-code model');
const manifest = readManifest(root);
if (manifest.guard?.outcome !== 'guard proven') throw new Error('T1 did not record guard proven; T2 must not prepare a live fixture');
if (manifest.t2Prepared) throw new Error('T2 fixture was already prepared in this root');

const sourceDist = path.resolve(options.dist ?? path.join(here, '..', '..', '..', 'dist'));
const sourceNodeModules = path.resolve(sourceDist, '..', 'node_modules');
const host = path.join(root, 'native-host');
const heimdall = path.join(host, 'heimdall');
const dist = path.join(heimdall, 'dist');
fs.mkdirSync(heimdall, { recursive: true, mode: 0o700 });
fs.cpSync(sourceDist, dist, { recursive: true, errorOnExist: true, force: false });
// The plugin reads prompts/planner.md and prompts/executor.md next to dist/ (the published package ships both).
fs.cpSync(path.resolve(sourceDist, '..', 'prompts'), path.join(heimdall, 'prompts'), { recursive: true, errorOnExist: true, force: false });
fs.symlinkSync(sourceNodeModules, path.join(heimdall, 'node_modules'), 'dir');
// Mirror the published package layout so the plugin computes its real runtime identity (name, version, lockfile, dist,
// prompts, agent files) from the fixture copy instead of reporting it unavailable. The sources are only read.
const sourceRoot = path.resolve(sourceDist, '..');
for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(sourceRoot, name), path.join(heimdall, name), fs.constants.COPYFILE_EXCL);
fs.cpSync(path.join(sourceRoot, 'examples', 'opencode', 'agents'), path.join(heimdall, 'examples', 'opencode', 'agents'), { recursive: true, errorOnExist: true, force: false });

// F1 accepts exactly the historical empty list or the final ['claude-code'] list in the fixture COPY of dist.
const patchProviderList = relative => {
  const file = path.join(dist, relative);
  const original = fs.readFileSync(file, 'utf8');
  const prepared = prepareProviderList(original);
  if (prepared.patched) fs.writeFileSync(file, prepared.text);
  return { file: `dist/${relative}`, found: prepared.found, patched: prepared.patched, before: sha256(original), after: sha256(fs.readFileSync(file)) };
};
const patches = [patchProviderList('opencode/report-only.js')];

// Fixture sources live next to the copied dist so '@opencode/plugin' and '../dist/...' resolve from the fixture.
const fixtureDirectory = path.join(heimdall, 'fixture');
fs.mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
for (const name of ['heimdall-fixture-plugin.mjs', 'observer-plugin.mjs', 'marker-mcp.mjs']) fs.copyFileSync(path.join(here, 'fixture', name), path.join(fixtureDirectory, name), fs.constants.COPYFILE_EXCL);

const pluginPackage = (name, entry) => {
  const directory = path.join(host, 'plugins', name);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', main: './index.js', exports: { '.': './index.js' } }, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'index.js'), entry, { mode: 0o600 });
  return directory;
};
const observerPre = pluginPackage('fixture-observer-pre', "import { makeObserver } from '../../heimdall/fixture/observer-plugin.mjs';\nexport default makeObserver('pre');\n");
const heimdallPlugin = pluginPackage('fixture-heimdall', "export { default } from '../../heimdall/fixture/heimdall-fixture-plugin.mjs';\n");
const observerPost = pluginPackage('fixture-observer-post', "import { makeObserver } from '../../heimdall/fixture/observer-plugin.mjs';\nexport default makeObserver('post');\n");

const markerDirectory = path.join(root, 'mcp-marker');
fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
const markerFile = path.join(markerDirectory, 'marker.jsonl');

const configDirectory = manifest.stores.configDirectory;
fs.writeFileSync(path.join(configDirectory, 'opencode.json'), JSON.stringify({
  plugins: [{ package: observerPre }, { package: heimdallPlugin }, { package: observerPost }, { package: manifest.provider }],
  mcp: { marker: { type: 'local', command: [process.execPath, path.join(fixtureDirectory, 'marker-mcp.mjs')], environment: { MARKER_FILE: markerFile }, enabled: true } },
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

// Agents (global config directory so the disposable repositories stay clean).
const agents = path.join(configDirectory, 'agents');
fs.mkdirSync(agents, { recursive: true, mode: 0o700 });
const example = name => fs.readFileSync(path.join(here, '..', '..', '..', 'examples', 'opencode', 'agents', `${name}.md`), 'utf8');
for (const name of ['adr-orchestrator', 'adr-planner', 'adr-executor']) fs.writeFileSync(path.join(agents, `${name}.md`), example(name), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(agents, 'fixture-worker.md'), '---\ndescription: Fixture agent with every tool allowed\nmode: primary\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: allow\n---\nYou are a disposable verification agent. Do exactly what the user asks, using the named tool when told to. Reply briefly.\n', { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(agents, 'fixture-worker-ask.md'), '---\ndescription: Fixture agent where every tool asks for permission\nmode: primary\npermissions:\n  - action: "*"\n    resource: "*"\n    effect: ask\n---\nYou are a disposable verification agent. Do exactly what the user asks, using the named tool when told to. Reply briefly.\n', { flag: 'wx', mode: 0o600 });

// Heimdall configuration for each disposable repository, excluded from git so the baselines stay clean.
const toml = `[workflow]
plannerAgent = "adr-planner"
executorAgent = "adr-executor"
plannerModel = "${plannerModel}"
${variant ? `plannerVariant = "${variant}"\n` : ''}maxTasks = 3
minQuotaRemainingPercent = 10
fiveHourQuotaWeight = 0.6
tokenLimitsDisabled = true

[[workflow.executorCandidates]]
key = "primary"
quotaProvider = "claude-code"
model = "claude-code/sonnet"
${variant ? `variant = "${variant}"\n` : ''}
[paths]
state = ".heimdall"
plans = ".heimdall/plans"

[opencode]
baseUrl = "http://127.0.0.1:${port}"
authentication = "none"
`;
const configure = repository => {
  fs.writeFileSync(path.join(repository, '.heimdall.toml'), toml, { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(repository, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(repository, '.git', 'info', 'exclude'), '.heimdall.toml\n.heimdall/\n.opencode/\n');
};
configure(manifest.repository);

const adr = `# ADR: add a farewell function

Add \`farewell(name)\` to \`src/impl.js\`. It returns the string \`goodbye <name>\`.
Add one test for it to \`test/impl.test.js\`. The test command is \`npm test\`.

Plan exactly ONE task, T1, covering both changes. Its definition of done:
1. \`src/impl.js\` exports \`farewell(name)\` returning \`goodbye <name>\`.
2. \`test/impl.test.js\` tests it and \`npm test\` passes.

Do not commit.
`;
const adrRepository = await createRepository(root, { name: 'repo-adr', extraFiles: { 'docs/adr.md': adr } });
configure(adrRepository.repository);

updateManifest(root, current => {
  current.t2Prepared = true;
  current.t2 = {
    preparedAt: new Date().toISOString(),
    port,
    variant: variant ?? null,
    plannerModel,
    fixtureOnly: patches,
    distCopyTreeSha256: sha256(JSON.stringify(hashTree(dist))),
    plugins: { order: ['fixture-observer-pre', 'fixture-heimdall', 'fixture-observer-post', 'opencode-claude'] },
    markerFile: '<root>/mcp-marker/marker.jsonl',
    controlSocket: '<root>/control.sock',
    repositories: { tools: manifest.repository, recovery: adrRepository.repository },
    recoveryRepositoryBaseline: { head: adrRepository.head, hashes: adrRepository.hashes },
  };
});
emit({ ok: true, root, port, patches, recoveryHead: adrRepository.head });
