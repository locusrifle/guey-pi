// Deterministic archive layout; exact dependencies come from package-lock.json.
// Build tools: Linux, Node >=22.19, npm, GNU tar and gzip. No user's npm config.
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (process.platform !== 'linux') throw new Error('Build the Linux archive on Linux for the target architecture');
const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const name = `guey-${pkg.version}-linux-${process.arch}`;
const dist = join(root, 'dist');
const temp = await mkdtemp(join(tmpdir(), 'guey-build-'));
const stage = join(temp, name);
try {
  await mkdir(stage); await mkdir(dist, { recursive: true });
  // Explicit allowlist: no records, personal skill, extension, settings or .git.
  // Both compositions share these modules. Stock remains the launcher default.
  // Missing notices are a build failure, not an optional omission.
  for (const file of ['server.mjs', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses', 'desktop/guey', 'desktop/main.mjs', 'desktop/install.sh']) {
    await cp(join(root, file), join(stage, file), { recursive: true });
  }
  await mkdir(join(stage, 'native'));
  for (const entry of (await readdir(join(root, 'native'))).sort()) {
    if (entry.endsWith('.mjs')) await cp(join(root, 'native', entry), join(stage, 'native', entry));
  }
  await cp(join(root, 'native/public'), join(stage, 'native/public'), { recursive: true });
  await cp(join(root, 'desktop/README.md'), join(stage, 'README.md'));
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  delete manifest.pi; manifest.scripts = { start: './desktop/guey start' };
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const home = join(temp, 'home'); await mkdir(home);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stage, stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: home, npm_config_engine_strict: 'true', npm_config_cache: join(temp, 'cache'), npm_config_userconfig: '/dev/null', npm_config_globalconfig: join(home, 'global-npmrc') },
  });
  execFileSync(process.execPath, [join(root, 'scripts/prune-sdk.mjs'), stage], { stdio: 'inherit' });
  await writeFile(join(stage, 'DESKTOP-BUNDLE'), `${name}\nPi SDK ${pkg.dependencies['@earendil-works/pi-coding-agent']} (other-OS binaries pruned)\nNode runtime not bundled; requires >=22.19\n`);
  // Record every payload byte, including third-party licenses, without host paths.
  const hashes = [];
  async function walk(dir, prefix = '') {
    for (const entry of (await readdir(dir)).sort()) {
      const path = join(dir, entry), relative = prefix + entry, st = await lstat(path);
      if (st.isDirectory()) await walk(path, relative + '/');
      else if (st.isFile()) hashes.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative}`);
    }
  }
  await walk(stage); await writeFile(join(stage, 'SHA256SUMS'), hashes.join('\n') + '\n');
  const tar = join(dist, name + '.tar');
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '-cf', tar, '-C', temp, name]);
  execFileSync('gzip', ['-n', '-f', tar]);
  const artifact = tar + '.gz';
  await writeFile(artifact + '.sha256', `${createHash('sha256').update(await readFile(artifact)).digest('hex')}  ${name}.tar.gz\n`);
  console.log(artifact);
} finally { await rm(temp, { recursive: true, force: true }); }
