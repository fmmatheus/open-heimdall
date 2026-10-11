import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Builds the npm tarball from a disposable copy of the working tree so that neither
// the checkout's dist/ nor its node_modules/ can leak into the package. Only tracked
// and untracked-but-not-ignored files are copied; dependencies are installed and the
// package is built inside the copy. The OpenChamber extension is never built here.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

async function command(file, args, options) {
  try {
    return await run(file, args, { maxBuffer: 256 * 1024 * 1024, ...options });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${file} ${args.join(' ')} failed${error.code === undefined ? '' : ` (exit ${error.code})`}${output ? `:\n${output}` : ''}`);
  }
}

function gitEnvironment(env) {
  const clean = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete clean[name];
  return clean;
}

export async function copyWorkingTree(source, destination, env = process.env) {
  const { stdout } = await command('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: source, env: gitEnvironment(env) });
  const files = [...new Set(stdout.split('\0').filter(Boolean))].sort();
  let copied = 0;
  for (const file of files) {
    const parts = file.split('/');
    if (parts[0] === 'node_modules' || parts[0] === 'dist') throw new Error(`Refusing to copy build output into the clean tree: ${file}`);
    const from = join(source, file);
    const stat = await lstat(from).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!stat) continue; // tracked file deleted in the working tree
    const to = join(destination, file);
    await mkdir(dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) await symlink(await readlink(from), to);
    else if (stat.isFile()) { await copyFile(from, to); await chmod(to, stat.mode & 0o777); }
    else continue;
    copied++;
  }
  return copied;
}

export async function packClean({ source = root, out, env = process.env, log = () => {}, keep = false } = {}) {
  const outputDirectory = resolve(out ?? await mkdtemp(join(os.tmpdir(), 'heimdall-pack-out-')));
  await mkdir(outputDirectory, { recursive: true });
  const work = await mkdtemp(join(os.tmpdir(), 'heimdall-pack-src-'));
  try {
    const copied = await copyWorkingTree(source, work, env);
    log(`copy: ${copied} files from the working tree (tracked and untracked, not ignored) into ${work}`);
    await command('npm', ['ci', '--ignore-scripts'], { cwd: work, env });
    log('npm ci --ignore-scripts: ok');
    await command('npm', ['run', 'build'], { cwd: work, env });
    log('npm run build: ok');
    const { stdout } = await command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outputDirectory], { cwd: work, env });
    const [result] = JSON.parse(stdout);
    if (!result?.filename || !Array.isArray(result.files)) throw new Error('npm pack returned no tarball description');
    const tarball = join(outputDirectory, result.filename.replaceAll('/', '-').replace(/^@/, ''));
    const files = result.files.map(file => file.path).sort();
    log('npm pack: ok');
    return { tarball, files, version: result.version, copied, work: keep ? work : undefined };
  } finally {
    if (!keep) await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { log: line => process.stdout.write(line + '\n'), keep: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--out') {
      const value = args.shift();
      if (!value) throw new Error('--out requires a directory');
      options.out = value;
    } else if (arg === '--keep') options.keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const { tarball, files, work } = await packClean(options);
  process.stdout.write(`tarball: ${tarball}\n`);
  if (work) process.stdout.write(`kept source copy: ${work}${sep}\n`);
  process.stdout.write(`inventory (${files.length} files):\n${files.map(file => '  ' + file).join('\n')}\n`);
}
