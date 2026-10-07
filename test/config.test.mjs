import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfiguration } from '../dist/config.js';

const minimal = `[workflow]\nplannerModel = "anthropic/planner"\nexecutorModel = "anthropic/executor"\nexecutorFallbackModel = "kimi-code-plan-global/fallback"\n`;
async function fixture(t, content = minimal) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.heimdall.toml');
  await fs.writeFile(file, content);
  return { directory, file, load: () => loadConfiguration({ projectDirectory: directory }) };
}
test('configuration defaults leave limits disabled and paths relative to the selected project', async t => {
  const f = await fixture(t);
  const configuration = await f.load();
  assert.equal(configuration.settings.tokenLimitsDisabled, true);
  assert.equal(configuration.settings.timeoutMinutes, undefined);
  assert.equal(configuration.settings.maxRunTokens, undefined);
  assert.equal(configuration.workflowRoot, path.join(f.directory, '.heimdall'));
  assert.equal(configuration.planRoot, path.join(f.directory, '.heimdall', 'plans'));
  assert.match(await fs.readFile(configuration.plannerPromptPath, 'utf8'), /planned/);
  assert.deepEqual(await fs.readdir(f.directory), ['.heimdall.toml'], 'checking configuration does not create run files');
});
test('configured state, prompt and quota-package paths avoid machine-specific defaults', async t => {
  const f = await fixture(t, minimal + 'packagePath = "local-quota"\n[paths]\nstate = "runtime/workflows"\nplannerPrompt = "prompts/plan.md"\nexecutorPrompt = "prompts/execute.md"\n[opencode]\nbaseUrl = "http://127.0.0.1:4321"\npasswordEnvironmentVariable = "TEST_OPENCODE_PASSWORD"\n');
  const c = await f.load();
  assert.equal(c.workflowRoot, path.join(f.directory, 'runtime', 'workflows'));
  assert.equal(c.planRoot, path.join(c.workflowRoot, 'plans'));
  assert.equal(c.plannerPromptPath, path.join(f.directory, 'prompts', 'plan.md'));
  assert.equal(c.settings.packagePath, path.join(f.directory, 'local-quota'));
  assert.deepEqual(c.opencode, { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'TEST_OPENCODE_PASSWORD', authentication: 'basic' });
});
test('configured limits require explicit budgets and reject malformed values', async t => {
  for (const value of ['tokenLimitsDisabled = false', 'maxRunTokens = -1', 'maxTasks = 11', 'timeoutMinutes = inf', 'tokenLimitsDisabled = "false"', 'fiveHourQuotaWeight = 0', 'fiveHourQuotaWeight = 1']) {
    const f = await fixture(t, minimal + value + '\n');
    await assert.rejects(f.load());
  }
  const f = await fixture(t, minimal + 'tokenLimitsDisabled = false\nmaxSessionTokens = 40\nmaxRunTokens = 100\n');
  assert.equal((await f.load()).settings.tokenLimitsDisabled, false);
});
test('misspelled controls and inline connection credentials fail configuration validation', async t => {
  for (const suffix of ['tokenLimitDisabled = false\n', '[opencode]\npassword = "synthetic"\n', '[opencode]\nbaseUrl = "http://user:synthetic@localhost:4321"\n', '[opencode]\nbaseUrl = "https://external.example"\n']) {
    const f = await fixture(t, minimal + suffix);
    await assert.rejects(f.load());
  }
});
test('settings reread changed models and caps while preserving run paths and native roles', async t => {
  const f = await fixture(t);
  const c = await f.load();
  await fs.writeFile(f.file, minimal.replace('anthropic/executor', 'anthropic/changed') + 'tokenLimitsDisabled = false\nmaxSessionTokens = 20\nmaxRunTokens = 50\n');
  const updated = await c.readSettings();
  assert.equal(updated.executorModel, 'anthropic/changed');
  assert.equal(updated.tokenLimitsDisabled, false);
  await fs.writeFile(f.file, minimal + '[paths]\nstate = "other-state"\n');
  await assert.rejects(c.readSettings(), /paths requires reloading/);
});
test('candidate order and variants survive TOML parsing; duplicate keys are rejected', async t => {
  const text = '[workflow]\nplannerModel = "anthropic/planner"\n[[workflow.executorCandidates]]\nkey = "one"\nquotaProvider = "anthropic"\nmodel = "anthropic/executor"\nvariant = "max"\n[[workflow.executorCandidates]]\nkey = "two"\nquotaProvider = "openai"\nmodel = "openai/fallback"\n';
  const f = await fixture(t, text);
  const settings = (await f.load()).settings;
  assert.deepEqual(settings.executorCandidates.map(c => c.key), ['one', 'two']);
  assert.equal(settings.executorCandidates[0].variant, 'max');
  await fs.writeFile(f.file, text.replace('key = "two"', 'key = "one"'));
  await assert.rejects(f.load(), /unique/);
  for (const reserved of ['model', 'variant', 'checkedAt']) {
    await fs.writeFile(f.file, text.replace('key = "one"', `key = "${reserved}"`));
    await assert.rejects(f.load(), /reserved/);
  }
});
test('planning artifacts must remain inside the project even when state is external', async t => {
  for (const paths of ['state = "../external-state"', 'plans = "../external-plans"', `plans = "${os.tmpdir().replaceAll('\\', '\\\\')}"`]) {
    const f = await fixture(t, minimal + '[paths]\n' + paths + '\n');
    await assert.rejects(f.load(), /inside the project/);
  }
  const f = await fixture(t, minimal + '[paths]\nstate = "../external-state"\nplans = "local-plans"\n');
  assert.equal((await f.load()).planRoot, path.join(f.directory, 'local-plans'));
});


test('local authentication defaults to basic and no-auth must be explicitly selected', async t => {
  const defaults = await fixture(t);
  assert.equal((await defaults.load()).opencode.authentication, 'basic');
  const none = await fixture(t, minimal + '[opencode]\nauthentication = "none"\nbaseUrl = "http://127.0.0.1:4096"\n');
  const configured = await none.load();
  assert.equal(configured.opencode.authentication, 'none');
  await fs.writeFile(none.file, minimal + '[opencode]\nauthentication = "basic"\nbaseUrl = "http://127.0.0.1:4096"\n');
  await assert.rejects(configured.readSettings(), /connection settings requires reloading/);
  for (const value of ['"disabled"', 'false', '1']) {
    const bad = await fixture(t, minimal + '[opencode]\nauthentication = ' + value + '\n');
    await assert.rejects(bad.load(), /authentication must be basic or none/);
  }
});
