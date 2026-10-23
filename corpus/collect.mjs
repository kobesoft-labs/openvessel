// Collects Astro 5/6 sites from GitHub into corpus/sites/ and writes corpus/sites.json.
// Requires an authenticated `gh` CLI. Usage: node corpus/collect.mjs [target=100]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const sitesDir = join(root, 'sites');
const target = Number(process.argv[2] ?? 100);
mkdirSync(sitesDir, { recursive: true });

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: opts.encoding ?? 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const api = (path) => JSON.parse(gh(['api', path]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function astroMajor(pkg) {
  const spec = pkg?.dependencies?.astro ?? pkg?.devDependencies?.astro;
  if (!spec) return null;
  const m = /(\d+)/.exec(spec.replace(/^[^\d]*/, ''));
  return m ? Number(m[1]) : null;
}

function readPkgAt(repo, ref, path = 'package.json') {
  try {
    const r = api(`repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
    return JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function download(repo, ref, dest, subdir = '') {
  const tmp = join(root, '.tmp-' + Math.random().toString(36).slice(2));
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, 'src.tgz');
  writeFileSync(tgz, execFileSync('gh', ['api', `repos/${repo}/tarball/${ref}`], { maxBuffer: 1 << 30 }));
  execFileSync('tar', ['xzf', tgz, '-C', tmp]);
  const top = readdirSync(tmp).find((n) => n !== 'src.tgz');
  const src = join(tmp, top, subdir);
  rmSync(dest, { recursive: true, force: true });
  renameSync(src, dest);
  rmSync(tmp, { recursive: true, force: true });
}

const list = existsSync(join(root, 'sites.json')) ? JSON.parse(readFileSync(join(root, 'sites.json'), 'utf8')) : [];
const have = new Set(list.map((s) => s.id));
const add = (s) => {
  if (have.has(s.id)) return;
  have.add(s.id);
  list.push(s);
  writeFileSync(join(root, 'sites.json'), JSON.stringify(list, null, 2) + '\n');
  console.log(`[${list.length}] ${s.id} (astro ${s.astro})`);
};

// 1) official examples from tagged Astro releases (one tag per major)
const astroTags = { 6: 'astro@6.4.8', 5: 'astro@5.18.2' };
for (const [major, tag] of Object.entries(astroTags)) {
  const tmp = join(root, '.tmp-astro-' + major);
  if (!existsSync(tmp)) {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'src.tgz'), execFileSync('gh', ['api', `repos/withastro/astro/tarball/${tag}`], { maxBuffer: 1 << 30 }));
    execFileSync('tar', ['xzf', join(tmp, 'src.tgz'), '-C', tmp, '*/examples/*']);
  }
  const top = readdirSync(tmp).find((n) => n !== 'src.tgz');
  for (const ex of readdirSync(join(tmp, top, 'examples'))) {
    const pkgPath = join(tmp, top, 'examples', ex, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.scripts?.build) continue;
    const id = `astro-${major}-examples__${ex}`;
    if (have.has(id)) continue;
    const dest = join(sitesDir, id);
    rmSync(dest, { recursive: true, force: true });
    renameSync(join(tmp, top, 'examples', ex), dest);
    add({ id, repo: 'withastro/astro', ref: tag, path: `examples/${ex}`, astro: astroMajor(pkg) ?? Number(major) });
  }
  rmSync(tmp, { recursive: true, force: true });
}

// 2) community sites/themes from GitHub search
const queries = ['topic:astro-theme', 'topic:astro-template', 'topic:astro-blog', 'topic:astro language:Astro', 'astro theme in:name,description language:Astro', 'astro portfolio language:Astro', 'starlight docs language:MDX'];
const seen = new Set();
outer: for (const q of queries) {
  for (let pageNo = 1; pageNo <= 5; pageNo++) {
    if (list.length >= target) break outer;
    let res;
    try {
      res = api(`search/repositories?q=${encodeURIComponent(q + ' pushed:>2025-03-01')}&sort=stars&order=desc&per_page=50&page=${pageNo}`);
    } catch (e) {
      console.warn('search failed', q, String(e).slice(0, 200));
      await sleep(30000);
      continue;
    }
    for (const r of res.items ?? []) {
      if (list.length >= target) break outer;
      const repo = r.full_name;
      if (seen.has(repo) || r.archived || r.fork) continue;
      seen.add(repo);
      const id = repo.replace('/', '__');
      if (have.has(id)) continue;
      const pkg = readPkgAt(repo, r.default_branch);
      const major = astroMajor(pkg);
      if (major !== 5 && major !== 6) continue;
      if (!pkg.scripts?.build) continue;
      if (r.size > 200_000) continue; // skip >200MB repos
      try {
        download(repo, r.default_branch, join(sitesDir, id));
      } catch (e) {
        console.warn('download failed', repo, String(e).slice(0, 200));
        continue;
      }
      add({ id, repo, ref: r.default_branch, sha: null, astro: major, stars: r.stargazers_count });
    }
    await sleep(2500);
  }
}
console.log(`done: ${list.length} sites`);
