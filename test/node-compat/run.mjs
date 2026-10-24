// Runs Node.js's own tests (test/parallel) inside OpenVessel and compares them with real Node.
//
//   node test/node-compat/fetch.mjs                 # sparse-clones nodejs/node at our NODE_VERSION into .node/
//   node test/node-compat/run.mjs --baseline        # real Node (npx node@<version>) → results/baseline.json
//   node test/node-compat/run.mjs [prefix...]       # OpenVessel → results/ov.json + results/logs/
//   node test/node-compat/run.mjs --report          # summary of failures grouped by cause
//   --port   run on the ported Node runtime (src/nodejs) instead of the legacy one; results go to results/port/
//
// Only tests that pass on real Node count. Tests that need V8/internal flags are skipped.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const here = new URL('.', import.meta.url).pathname;
const nodeRoot = join(here, '.node');
const parallel = join(nodeRoot, 'test/parallel');
const resultsDir = join(here, process.argv.includes('--port') ? 'results/port' : 'results');
const baselineFile = join(here, 'results', 'baseline.json');
mkdirSync(join(resultsDir, 'logs'), { recursive: true });
const NODE_VERSION = /NODE_VERSION = '([^']+)'/.exec(readFileSync(join(here, '../../src/node/version.ts'), 'utf8'))[1];

const MODULES = ['fs', 'path', 'events', 'event-emitter', 'eventemitter', 'stream', 'stream2', 'stream3', 'readable', 'buffer', 'util', 'worker', 'crypto', 'child-process', 'url', 'whatwg-url', 'string-decoder', 'zlib', 'timers', 'process', 'module', 'require', 'readline', 'os', 'querystring', 'assert', 'abortcontroller', 'console', 'vm', 'async-local-storage', 'next-tick', 'promises', 'microtask', 'queue-microtask', 'wasi'];
const SKIP_SOURCE = /expose[-_]internals|internalBinding|--expose-gc|common\/inspector|--inspect|--cpu-prof|--heap-prof|--prof\b|--trace-|--report|--diagnostic|--allow-natives-syntax|--max-old-space|--abort-on-uncaught|common\/sea|common\/v8|v8\.setFlagsFromString|--experimental-permission|--permission|process\.binding|--snapshot|--build-snapshot|--frozen-intrinsics|--icu|common\/shared-lib-util|common\/wpt|common\/benchmark|common\/debugger|--watch/;
const PER_TEST_MS = 30000;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const prefixes = args.filter((a) => !a.startsWith('--'));

function moduleOf(file) {
  const name = file.replace(/^test-/, '').replace(/\.m?js$/, '');
  let best = '';
  for (const m of MODULES) if ((name === m || name.startsWith(m + '-')) && m.length > best.length) best = m;
  return best || null;
}

function selectTests() {
  const out = [];
  for (const f of readdirSync(parallel).sort()) {
    if (!/^test-.*\.(js|mjs)$/.test(f)) continue;
    const mod = moduleOf(f);
    if (!mod) continue;
    if (prefixes.length && !prefixes.some((p) => f.startsWith('test-' + p))) continue;
    const src = readFileSync(join(parallel, f), 'utf8');
    if (SKIP_SOURCE.test(src)) continue;
    out.push({ file: f, mod });
  }
  return out;
}

const loadJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const firstError = (out) => {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const l = lines.find((x) => /^(\w*Error|AssertionError|Error \[|TypeError|RangeError|SyntaxError|ReferenceError)/.test(x) || /^(node:)?internal.*:\d+$/.test(x) === false && /Error:/.test(x));
  return (l ?? lines.at(-1) ?? '').slice(0, 200);
};

// ---------------------------------------------------------------------------
// baseline: real Node

async function baseline(tests) {
  const nodeBin = execFileSync('npx', ['-y', `node@${NODE_VERSION}`, '-p', 'process.execPath'], { encoding: 'utf8' }).trim();
  console.log('baseline with', nodeBin);
  const res = loadJson(baselineFile, {});
  let i = 0;
  const run = (t) =>
    new Promise((resolve) => {
      const p = spawn(nodeBin, [join('test/parallel', t.file)], { cwd: nodeRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_DIR: undefined } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => p.kill('SIGKILL'), PER_TEST_MS);
      p.on('close', (code, sig) => {
        clearTimeout(timer);
        const skipped = /^1\.\.0 # Skipped/m.test(out);
        res[t.file] = { pass: code === 0 && !skipped, skipped, code: sig ? sig : code };
        resolve();
      });
    });
  const queue = [...tests];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let t; (t = queue.shift()); ) {
        await run(t);
        if (++i % 100 === 0) console.log(`${i}/${tests.length}`);
      }
    }),
  );
  writeFileSync(baselineFile, JSON.stringify(res, null, 1));
  const pass = Object.values(res).filter((r) => r.pass).length;
  console.log(`baseline: ${pass}/${tests.length} pass on real Node`);
}

// ---------------------------------------------------------------------------
// OpenVessel

function collect(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, base, out);
    else if (st.size <= 8 * 1024 * 1024) out.push([relative(base, p), p]);
  }
  return out;
}

async function mount(page, files) {
  // in chunks, so a single evaluate doesn't carry tens of MB
  let batch = {};
  let size = 0;
  const flush = async () => {
    if (!size) return;
    await page.evaluate(async (b) => {
      const decoded = {};
      for (const [k, v] of Object.entries(b)) decoded[k] = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
      await window.ov.mount(decoded, { path: '/node' });
    }, batch);
    batch = {};
    size = 0;
  };
  for (const [rel, abs] of files) {
    const b = readFileSync(abs);
    batch[rel] = b.toString('base64');
    size += b.length;
    if (size > 4e6) await flush();
  }
  await flush();
}

async function runOv(tests) {
  const { startServer, openBrowser } = await import('../e2e/harness.mjs');
  const base = loadJson(baselineFile, null);
  if (base) tests = tests.filter((t) => base[t.file]?.pass);
  console.log(`running ${tests.length} tests in OpenVessel`);
  const res = loadJson(join(resultsDir, 'ov.json'), {});
  const files = [['package.json', join(nodeRoot, 'package.json')], ...collect(join(nodeRoot, 'test/common'), nodeRoot, []), ...collect(join(nodeRoot, 'test/fixtures'), nodeRoot, []), ...tests.map((t) => [`test/parallel/${t.file}`, join(parallel, t.file)])];
  const srv = await startServer();
  let session;
  const boot = async () => {
    try {
      await session?.browser.close();
    } catch {}
    // a throwaway profile, so a browser that is still shutting down can't block the relaunch
    for (let attempt = 0; ; attempt++) {
      try {
        session = await openBrowser({ profile: mkdtempSync(join(tmpdir(), 'ov-compat-')) });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await session.page.evaluate(() => {
      // no preview iframe connecting to the servers the tests start
      window.ovNoAutoPreview = true;
      return window.ov.network.setPolicy({ mode: 'allow-all' });
    });
    if (flag('--port')) await session.page.evaluate(() => window.ov.exec('mkdir -p /etc/openvessel && echo port > /etc/openvessel/node'));
    await mount(session.page, files);
  };
  await boot();
  let done = 0;
  const t0 = Date.now();
  try {
    const queue = [...tests];
    const worker = async () => {
      for (let t; (t = queue.shift()); ) {
        let r;
        try {
          r = await session.page.evaluate(
            async ({ file, ms }) => {
              const ov = window.ov;
              const t0 = performance.now();
              const p = await ov.spawn('node', [`test/parallel/${file}`], { cwd: '/node' });
              let timedOut = false;
              const timer = setTimeout(() => {
                timedOut = true;
                p.kill('SIGKILL');
              }, ms);
              const code = await Promise.race([p.exit, new Promise((r) => setTimeout(() => r(-1), ms + 3000))]);
              clearTimeout(timer);
              return { code, timedOut: timedOut || code === -1, out: p.collected.slice(-20000), ms: Math.round(performance.now() - t0) };
            },
            { file: t.file, ms: PER_TEST_MS },
            { timeout: PER_TEST_MS + 15000 },
          );
        } catch (e) {
          r = { code: -2, timedOut: true, out: `harness: ${e.message}`, ms: PER_TEST_MS };
          await boot();
        }
        const skipped = /^1\.\.0 # Skipped/m.test(r.out);
        res[t.file] = { mod: t.mod, pass: r.code === 0 && !skipped, skipped, code: r.code, timedOut: r.timedOut, ms: r.ms, error: r.code === 0 ? '' : r.timedOut ? 'TIMEOUT' : firstError(r.out) };
        writeFileSync(join(resultsDir, 'logs', t.file + '.log'), r.out);
        if (++done % 25 === 0) {
          writeFileSync(join(resultsDir, 'ov.json'), JSON.stringify(res, null, 1));
          const pass = Object.values(res).filter((x) => x.pass).length;
          console.log(`${done}/${tests.length} (${pass} pass so far, ${Math.round((Date.now() - t0) / 1000)}s)`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  } finally {
    writeFileSync(join(resultsDir, 'ov.json'), JSON.stringify(res, null, 1));
    await session.browser.close();
    srv.kill();
  }
  report();
}

// ---------------------------------------------------------------------------
// report

/** shape: only the error's code/message/validation differs; value: a result differs; crash: an unexpected exception; timeout. */
function classify(file, r) {
  if (r.timedOut) return { kind: 'timeout', detail: 'TIMEOUT' };
  const log = existsSync(join(resultsDir, 'logs', file + '.log')) ? readFileSync(join(resultsDir, 'logs', file + '.log'), 'utf8') : '';
  const lines = log.split('\n');
  const head = lines.findIndex((l) => /^\w*(Error|Exception)\b|^Error \[|^\w+Error:|^AssertionError/.test(l));
  const first = (head >= 0 ? lines[head] : r.error || '').trim();
  const at = lines.slice(Math.max(0, head)).find((l) => /\/node\/test\/parallel\/[^:]+:\d+/.test(l));
  const where = at ? /test\/parallel\/([^:]+:\d+)/.exec(at)[1] : '';
  if (/^AssertionError/.test(first)) {
    if (/Missing expected (exception|rejection)/.test(first)) return { kind: 'shape', detail: 'no error thrown (argument validation)', where };
    const cmp = log.match(/^[+-]\s+(code|message|name|errno|syscall): /m);
    if (cmp || /is expected to match the expected value/.test(log)) return { kind: 'shape', detail: `error ${cmp?.[1] ?? 'validation'} differs`, where };
    const diff = lines.slice(head + 1, head + 8).filter((l) => l.trim() && !/^\s+at /.test(l)).join(' ').replace(/\s+/g, ' ').slice(0, 140);
    return { kind: 'value', detail: diff || first.slice(0, 140), where };
  }
  return { kind: 'crash', detail: first.replace(/\/node\/test\/[^\s)]+/g, '<test>').slice(0, 160), where };
}

/**
 * Tests that can't pass in a browser, with the reason (limits/<module>.json: { "test-x.js": "why" }).
 * They don't count toward the target; one that passes anyway is reported so it can be removed.
 */
function loadLimits() {
  const dir = join(here, 'limits');
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) Object.assign(out, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return out;
}

function report() {
  const base = loadJson(baselineFile, {});
  const res = loadJson(join(resultsDir, 'ov.json'), {});
  const limits = loadLimits();
  const byMod = {};
  const causes = { crash: {}, value: {}, timeout: {}, shape: {} };
  const passingLimits = [];
  for (const [file, r] of Object.entries(res)) {
    if (base[file] && !base[file].pass) continue;
    const m = (byMod[r.mod] ??= { pass: 0, total: 0, limit: 0, crash: 0, value: 0, timeout: 0, shape: 0 });
    m.total++;
    if (limits[file]) {
      m.limit++;
      if (r.pass) passingLimits.push(file);
      continue;
    }
    if (r.pass) {
      m.pass++;
      continue;
    }
    const c = classify(file, r);
    m[c.kind]++;
    const key = c.detail.replace(/'[^']*'|"[^"]*"|\b\d+\b/g, '…');
    (causes[c.kind][key] ??= []).push(file + (c.where ? ` (${c.where.split(':')[1]})` : ''));
  }
  const lines = ['| module | pass | target | % | limits | total | crash | value | timeout | shape |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  const sum = { pass: 0, total: 0, limit: 0, crash: 0, value: 0, timeout: 0, shape: 0 };
  const pct = (p, t) => (t ? ((100 * p) / t).toFixed(1) : '100.0');
  for (const [m, v] of Object.entries(byMod).sort((a, b) => b[1].total - a[1].total)) {
    const target = v.total - v.limit;
    lines.push(`| ${m} | ${v.pass} | ${target} | ${pct(v.pass, target)} | ${v.limit} | ${v.total} | ${v.crash} | ${v.value} | ${v.timeout} | ${v.shape} |`);
    for (const k of Object.keys(sum)) sum[k] += v[k];
  }
  const target = sum.total - sum.limit;
  lines.push(`| **all** | **${sum.pass}** | **${target}** | **${pct(sum.pass, target)}** | ${sum.limit} | ${sum.total} | ${sum.crash} | ${sum.value} | ${sum.timeout} | ${sum.shape} |`, '');
  lines.push('target: tests that pass on real Node, minus the documented limits (limits/*.json) · crash: unexpected exception · value: a result differs · timeout: hung (30s) · shape: only the error code/message or argument validation differs', '');
  if (passingLimits.length) lines.push(`**Listed as limits but passing** (remove from limits/): ${passingLimits.join(', ')}`, '');
  for (const kind of ['crash', 'value', 'timeout', 'shape']) {
    lines.push(`## ${kind}`, '');
    for (const [k, files] of Object.entries(causes[kind]).sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`- **${files.length}** \`${k}\`  `, `  ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`);
    }
    lines.push('');
  }
  writeFileSync(join(resultsDir, 'REPORT.md'), lines.join('\n') + '\n');
  console.log(lines.slice(0, Object.keys(byMod).length + 3).join('\n'));
  console.log(`\nfull report: ${join(resultsDir, 'REPORT.md')}`);
}

const tests = selectTests();
if (flag('--report')) report();
else if (flag('--baseline')) await baseline(tests);
else await runOv(tests);
