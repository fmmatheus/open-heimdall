import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseManifestJson } from '@openchamber/sdk/schemas';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

test('extension build produces an installable OpenChamber package', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'heimdall-extension-build-'));
  const out = join(parent, 'extension');
  try {
    await execFileAsync(process.execPath, [join(root, 'scripts', 'build-extension.mjs'), '--out', out], { cwd: root });

    for (const file of ['package.json', 'panel/index.html', 'panel/main.js', 'service/main.js']) {
      await access(join(out, file));
    }

    const result = parseManifestJson(await readFile(join(out, 'package.json'), 'utf8'));
    assert.equal(result.ok, true, JSON.stringify(result));
    const manifest = result.manifest;
    assert.equal(manifest.apiVersion, 1);
    assert.equal(JSON.parse(await readFile(join(out, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(manifest.contributes.panel.id, 'heimdall');
    assert.equal(manifest.contributes.panel.entry, 'panel/index.html');
    assert.deepEqual(manifest.contributes.capabilities, ['sessions']);
    assert.equal(manifest.contributes.service?.entry, 'service/main.js');
    assert.equal(manifest.contributes.service?.runtime, 'host');

    const html = await readFile(join(out, 'panel', 'index.html'), 'utf8');
    assert.match(html, /<script src="main\.js"><\/script>/);
    assert.doesNotMatch(html.replace(/<script src="main\.js"><\/script>/, ''), /<script/);

    const panel = await readFile(join(out, 'panel', 'main.js'), 'utf8');
    assert.doesNotMatch(panel, /^\s*(import|export)\s/m);

    const service = await readFile(join(out, 'service', 'main.js'), 'utf8');
    assert.equal(service.includes('node:sqlite'), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('extension build fails with a nonzero exit when --out has no value', async () => {
  await assert.rejects(execFileAsync(process.execPath, [join(root, 'scripts', 'build-extension.mjs'), '--out'], { cwd: root }), (error) => {
    assert.notEqual(error.code, 0);
    return true;
  });
});
