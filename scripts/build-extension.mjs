import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function outputDirectory(argv) {
  const index = argv.indexOf('--out');
  if (index === -1) return join(root, 'dist', 'openchamber-extension');
  const value = argv[index + 1];
  if (!value) throw new Error('--out requires a directory');
  return resolve(value);
}

async function main() {
  const out = outputDirectory(process.argv.slice(2));
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'panel'), { recursive: true });
  await mkdir(join(out, 'service'), { recursive: true });

  await cp(join(root, 'extension', 'package.json'), join(out, 'package.json'));
  await cp(join(root, 'extension', 'panel', 'index.html'), join(out, 'panel', 'index.html'));
  await cp(join(root, 'extension', 'icon.svg'), join(out, 'icon.svg')).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });

  await build({
    entryPoints: [join(root, 'src', 'extension', 'panel', 'main.ts')],
    outfile: join(out, 'panel', 'main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome140',
    logLevel: 'warning',
  });

  await build({
    entryPoints: [join(root, 'src', 'extension', 'service', 'main.ts')],
    outfile: join(out, 'service', 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    banner: {
      js: "import { createRequire as __heimdallCreateRequire } from 'node:module'; const require = __heimdallCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
