import { test } from 'node:test';
import assert from 'node:assert/strict';
import { npmKernel, ECHO_ARGS } from './npm-fixtures.ts';

const echoPkg = { '1.0.0': { bin: { echoargs: 'bin/echoargs' }, files: { 'bin/echoargs': ECHO_ARGS } } };
const scripts = { show: 'echo SHOW-SCRIPT', info: 'echo INFO-SCRIPT', build: 'echo build' };

test('-h/--help after the command name or after -- belongs to the command', async () => {
  const { sh, write } = npmKernel({ echoargs: echoPkg });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', scripts, dependencies: { echoargs: '1.0.0' } });
  assert.equal((await sh('npm install -s')).code, 0);
  let r = await sh('npx echoargs --help -y');
  assert.equal(r.stdout, '[--help]\n[-y]\n');
  r = await sh('npm run build -- --help');
  assert.match(r.stdout, /> echo build --help\n\nbuild --help\n/);
  r = await sh('npm exec -- echoargs -h');
  assert.equal(r.stdout, '[-h]\n');
  // the client's own -h still prints its usage
  assert.match((await sh('npm run build --help')).stdout, /^Usage: npm <command>/);
  assert.match((await sh('pnpm --help')).stdout, /^Usage: pnpm <command>/);
});

test('arguments after the script name: yarn/pnpm/bun pass them on, npm takes unknown flags before --', async () => {
  const { sh, write } = npmKernel({});
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', scripts: { build: 'echo build' } });
  assert.equal((await sh('yarn build --watch -h')).stdout, '$ echo build --watch -h\nbuild --watch -h\n');
  assert.equal((await sh('yarn run build --watch')).stdout, '$ echo build --watch\nbuild --watch\n');
  const y = await sh('yarn build -- --watch');
  assert.equal(y.stdout, '$ echo build --watch\nbuild --watch\n');
  assert.match(y.stderr, /scripts don't require "--"/);
  assert.match((await sh('pnpm build --watch')).stdout, /> echo build --watch\n\nbuild --watch\n/);
  // pnpm passes a `--` on to the script
  assert.match((await sh('pnpm run build -- --watch')).stdout, /\nbuild -- --watch\n/);
  assert.match((await sh('bun run build -- --watch')).stdout, /\nbuild --watch\n/);
  // npm keeps --watch as config: the script sees npm_config_watch, and npm warns
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', scripts: { build: 'echo build', env: 'echo "w=$npm_config_watch m=$npm_config_mode"' } });
  const n = await sh('npm run build --watch foo');
  assert.match(n.stdout, /\nbuild foo\n/);
  assert.equal(n.stderr, 'npm warn Unknown cli config "--watch". This will stop working in the next major version of npm.\n');
  const e = await sh('npm run env --watch --mode=prod --no-fund');
  assert.match(e.stdout, /\nw=true m=prod\n/);
  assert.doesNotMatch(e.stderr, /--fund/);
  assert.match((await sh('npm run -s build -- --watch')).stdout, /^build --watch\n/);
});

test('bunx and pnpx pass flags to the command', async () => {
  const { sh, write } = npmKernel({ echoargs: echoPkg });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0' });
  assert.equal((await sh('bunx echoargs --watch -p x')).stdout, '[--watch]\n[-p]\n[x]\n');
  assert.equal((await sh('pnpx echoargs --watch')).stdout, '[--watch]\n');
});

test('npx -p / --package installs the package and runs the command from it', async () => {
  const { sh, write } = npmKernel({ echoargs: echoPkg });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0' });
  let r = await sh('npx -p echoargs echoargs a --b');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '[a]\n[--b]\n');
  assert.match(r.stderr, /npm warn exec The following package was not found and will be installed: echoargs@1\.0\.0/);
  r = await sh('npx --package=echoargs@1 --yes -- echoargs c');
  assert.equal(r.stdout, '[c]\n');
  assert.equal(r.stderr, '');
  r = await sh('npx -p echoargs -c "echoargs d e"');
  assert.equal(r.stdout, '[d]\n[e]\n');
  // --no refuses to install
  r = await sh('npx --no -p other-echo echoargs');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /npx canceled due to missing packages and no YES option/);
});

test('install foo@<dist-tag> saves ^<version>', async () => {
  const { sh, write, read } = npmKernel({ foo: { '1.0.0': {}, '2.0.0-beta.1': {}, '1.1.0': {} } }, { foo: { next: '2.0.0-beta.1' } });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0' });
  assert.equal((await sh('npm i foo@latest -s')).code, 0);
  assert.equal(JSON.parse(read('/home/user/app/package.json')).dependencies.foo, '^1.1.0');
  await sh('npm i foo@next -s');
  assert.equal(JSON.parse(read('/home/user/app/package.json')).dependencies.foo, '^2.0.0-beta.1');
  await sh('npm i foo@1.0.0 -s');
  assert.equal(JSON.parse(read('/home/user/app/package.json')).dependencies.foo, '^1.0.0');
  await sh('npm i foo@~1.0.0 -s');
  assert.equal(JSON.parse(read('/home/user/app/package.json')).dependencies.foo, '~1.0.0');
  assert.equal(JSON.parse(read('/home/user/app/node_modules/foo/package.json')).version, '1.0.0');
});

test('npm view reads the full document (license, description)', async () => {
  const { sh } = npmKernel({ foo: { '1.0.0': { license: 'MIT', description: 'A foo.' }, '1.2.0': { license: 'MIT', description: 'A foo.', dependencies: { bar: '^1' } } } });
  let r = await sh('npm view foo');
  assert.match(r.stdout, /^\nfoo@1\.2\.0 \| MIT \| deps: 1 \| versions: 2\nA foo\.\n/);
  assert.match(r.stdout, /\ndist-tags:\nlatest: 1\.2\.0\n/);
  r = await sh('npm view foo description');
  assert.equal(r.stdout, 'A foo.\n');
  r = await sh('npm view foo version license');
  assert.equal(r.stdout, "version = '1.2.0'\nlicense = 'MIT'\n");
  r = await sh('npm view foo@1 version');
  assert.equal(r.stdout, "foo@1.0.0 '1.0.0'\nfoo@1.2.0 '1.2.0'\n");
  r = await sh('npm view foo@3');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No match found for version 3/);
});

test('yarn writes yarn.lock (v1) and reads it back', async () => {
  const { sh, write, read } = npmKernel({ 'is-odd': { '3.0.1': { dependencies: { 'is-number': '^6.0.0' } } }, 'is-number': { '6.0.0': {}, '7.0.0': {} } });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', dependencies: { 'is-odd': '^3.0.0', isnum: 'npm:is-number@^7.0.0' } });
  let r = await sh('yarn install');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /success Saved lockfile\./);
  const lock = read('/home/user/app/yarn.lock');
  assert.match(lock, /^# THIS IS AN AUTOGENERATED FILE\. DO NOT EDIT THIS FILE DIRECTLY\.\n# yarn lockfile v1\n\n\nis-number@\^6\.0\.0:\n  version "6\.0\.0"\n  resolved "https:\/\/registry\.npmjs\.org\/is-number\/-\/is-number-6\.0\.0\.tgz#[0-9a-f]{40}"\n  integrity sha512-\S+\n\nis-odd@\^3\.0\.0:\n  version "3\.0\.1"\n/);
  assert.match(lock, /\n  dependencies:\n    is-number "\^6\.0\.0"\n\n"isnum@npm:is-number@\^7\.0\.0":\n  version "7\.0\.0"\n/);
  r = await sh('yarn');
  assert.match(r.stdout, /^success Already up-to-date\.\nDone in/);
  // --frozen-lockfile doesn't write it
  write('/home/user/app/yarn.lock', 'x');
  await sh('yarn install --frozen-lockfile -s');
  assert.equal(read('/home/user/app/yarn.lock'), 'x');
});

test('npm root -g is where global packages are, and npm help is a command', async () => {
  const { sh, k } = npmKernel({ echoargs: echoPkg });
  const root = (await sh('npm root -g')).stdout.trim();
  assert.equal((await sh('npm install -g echoargs -s')).code, 0);
  assert.ok(k.vfs.exists(`${root}/echoargs/package.json`));
  assert.equal((await sh('echoargs q', '/')).stdout, '[q]\n');
  assert.equal((await sh('npm uninstall -g echoargs -s')).code, 0);
  assert.ok(!k.vfs.tryLookup('/usr/local/bin/echoargs', false));
  const h = await sh('npm help');
  assert.equal(h.code, 0);
  assert.match(h.stdout, /^npm <command>/);
});

test('scripts win over commands the client does not have; built-in commands win over scripts', async () => {
  const { sh, write } = npmKernel({});
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', scripts: { ...scripts, t: 'echo T-SCRIPT', list: 'echo LIST-SCRIPT' } });
  assert.match((await sh('yarn show')).stdout, /SHOW-SCRIPT/);
  assert.match((await sh('bun show')).stdout, /SHOW-SCRIPT/);
  assert.match((await sh('yarn t')).stdout, /T-SCRIPT/);
  assert.match((await sh('bun t')).stdout, /T-SCRIPT/);
  // pnpm has show/info/t as commands; yarn has info and list; bun has info
  assert.doesNotMatch((await sh('pnpm show nothing')).stdout, /SHOW-SCRIPT/);
  assert.doesNotMatch((await sh('yarn info nothing')).stdout, /INFO-SCRIPT/);
  assert.doesNotMatch((await sh('yarn list')).stdout, /LIST-SCRIPT/);
  // neither a command, a script nor a local binary
  let r = await sh('yarn nosuch');
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'error Command "nosuch" not found.\n');
  r = await sh('bun nosuch');
  assert.equal(r.stderr, 'error: Script not found "nosuch"\n');
  // pnpm runs any command
  assert.equal((await sh('pnpm echo hi')).stdout, 'hi\n');
});

const wsPackages = { 'is-number': { '6.0.0': {}, '7.0.0': {} } };
function workspace(write: (p: string, d: unknown) => void) {
  write('/home/user/app/package.json', { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'], scripts: { build: 'echo root-build' } });
  write('/home/user/app/packages/a/package.json', { name: 'a', version: '1.0.0', scripts: { build: 'echo a-build' }, dependencies: { 'is-number': '^7.0.0' } });
  write('/home/user/app/packages/b/package.json', { name: '@x/b', version: '2.0.0', scripts: { build: 'echo b-build', only: 'echo b-only' } });
}

test('workspace selection: npm -w, pnpm --filter, yarn workspace, bun --filter', async () => {
  const { sh, write, read } = npmKernel(wsPackages);
  workspace(write);
  assert.equal((await sh('npm install -s')).code, 0);
  let r = await sh('npm run build -w a');
  assert.match(r.stdout, /> a@1\.0\.0 build\n> echo a-build\n\na-build\n/);
  assert.doesNotMatch(r.stdout, /root-build/);
  r = await sh('npm run build --workspaces -s');
  assert.equal(r.stdout, 'a-build\nb-build\n');
  r = await sh('npm run build -w packages/b -s');
  assert.equal(r.stdout, 'b-build\n');
  r = await sh('npm run build -w nope');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No workspaces found:\nnpm error   --workspace=nope/);
  r = await sh('pnpm --filter "@x/*" build');
  assert.match(r.stdout, /b-build/);
  assert.doesNotMatch(r.stdout, /a-build/);
  r = await sh('pnpm -r only');
  assert.match(r.stdout, /b-only/);
  r = await sh('pnpm -r run nothing');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /None of the selected packages has a "nothing" script/);
  r = await sh('pnpm --filter "./packages/a" build');
  assert.match(r.stdout, /a-build/);
  r = await sh('yarn workspace @x/b only');
  assert.equal(r.stdout, '$ echo b-only\nb-only\n');
  r = await sh('bun run --filter a build');
  assert.match(r.stdout, /a-build/);
  // add to a workspace, install at the root
  r = await sh('npm install is-number@6.0.0 -w @x/b -s');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(read('/home/user/app/packages/b/package.json')).dependencies['is-number'], '^6.0.0');
  assert.equal(JSON.parse(read('/home/user/app/package.json')).dependencies, undefined);
  // installing from inside a workspace installs the whole project
  r = await sh('npm install', '/home/user/app/packages/a');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /up to date/);
});

test('a second install leaves workspace links alone', async () => {
  const { sh, write, read } = npmKernel(wsPackages);
  workspace(write);
  let r = await sh('npm install');
  assert.match(r.stdout, /added 3 packages/);
  r = await sh('npm install');
  assert.match(r.stdout, /\nup to date in /);
  const lock = JSON.parse(read('/home/user/app/node_modules/.package-lock.json'));
  assert.deepEqual(lock.packages['node_modules/a'], { version: '1.0.0', resolved: 'packages/a', link: true });
  assert.deepEqual(lock.packages['packages/a'], { name: 'a', version: '1.0.0' });
  // a workspace that is gone loses its link
  write('/home/user/app/package.json', { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/a'] });
  await sh('npm install -s');
  assert.equal((await sh('test -e node_modules/@x/b && echo yes || echo no')).stdout, 'no\n');
});

test('NODE_ENV=production omits devDependencies unless --include=dev', async () => {
  const { sh, write, k } = npmKernel({ foo: { '1.0.0': {} } });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', devDependencies: { foo: '1.0.0' } });
  await sh('NODE_ENV=production npm install -s');
  assert.ok(!k.vfs.exists('/home/user/app/node_modules/foo'));
  await sh('NODE_ENV=production npm install --include=dev -s');
  assert.ok(k.vfs.exists('/home/user/app/node_modules/foo'));
});

test('a WebAssembly substitute records the version that was unpacked', async () => {
  const { sh, write, read } = npmKernel({ esbuild: { '0.20.1': {} }, 'esbuild-wasm': { '0.20.0': {}, '0.20.2': {} } });
  write('/home/user/app/package.json', { name: 'app', version: '1.0.0', dependencies: { esbuild: '0.20.1' } });
  assert.equal((await sh('npm install -s')).code, 0);
  const pj = JSON.parse(read('/home/user/app/node_modules/esbuild/package.json'));
  assert.equal(pj.version, '0.20.1');
  assert.equal(pj._openvesselSource, 'esbuild-wasm@0.20.2');
});
