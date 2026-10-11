import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copies the pinned quota provider modules, and only the files they import, into
// dist/vendor/opencode-quota. The upstream package declares an exact peer on an
// older @opencode/plugin, which no consumer can satisfy next to the tested one, so
// Heimdall ships these modules instead of installing the package. The upstream
// package stays a development dependency that this build step reads.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@slkiser/opencode-quota';
const packageVersion = '5.0.1';
const entryFiles = ['dist/lib/opencode-auth.js', 'dist/providers/anthropic.js', 'dist/providers/kimi-code.js', 'dist/providers/openai.js'];
// Bare specifiers the copied modules may import; each must be a dependency of this package.
const allowedPackages = new Set(['comment-json']);
const importPattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name]));

export function vendorDirectory(base = root) {
  return join(base, 'dist', 'vendor', 'opencode-quota');
}

export async function vendorQuota({ base = root, source = join(base, 'node_modules', ...packageName.split('/')) } = {}) {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (manifest.name !== packageName || manifest.version !== packageVersion) {
    throw new Error(`Expected ${packageName} ${packageVersion} in ${source}, found ${manifest.name} ${manifest.version}`);
  }
  const files = new Set();
  const external = new Set();
  const visit = async file => {
    if (files.has(file)) return;
    files.add(file);
    const text = await readFile(file, 'utf8');
    if (/import\.meta|__dirname|new URL\(|createRequire/.test(text)) throw new Error(`${relative(source, file)} locates package files at runtime; review before vendoring`);
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (specifier.startsWith('.')) await visit(resolve(dirname(file), specifier));
      else if (!builtins.has(specifier)) external.add(specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'));
    }
  };
  for (const entry of entryFiles) await visit(join(source, entry));
  for (const name of external) {
    if (!allowedPackages.has(name)) throw new Error(`Vendored quota modules import unexpected package ${name}`);
  }

  const target = vendorDirectory(base);
  await rm(target, { recursive: true, force: true });
  for (const file of files) {
    const destination = join(target, relative(source, file));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
  }
  await copyFile(join(source, 'LICENSE'), join(target, 'LICENSE'));
  // The loader checks this manifest's identity before importing any module.
  await writeFile(join(target, 'package.json'), JSON.stringify({
    name: packageName,
    version: packageVersion,
    description: 'Provider modules vendored from ' + packageName + ' for @open-heimdall/core',
    type: 'module',
    license: manifest.license,
    homepage: manifest.homepage,
    private: true,
  }, null, 2) + '\n');
  return { target, files: files.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { target, files } = await vendorQuota();
  process.stdout.write(`Vendored ${files} ${packageName} ${packageVersion} files into ${relative(root, target)}\n`);
}
