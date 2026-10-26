// Checks the ported runtime's command line and runtime bindings against real Node: --env-file, --run,
// --stack-trace-limit and V8 flags, os/uname values, import.meta.dirname/filename, fetch to a virtual
// https port, and async_hooks for native resources. Expected outputs are what Node v22.23.4 prints on
// Linux (OpenVessel's own values where the machine shows through: uname, paths under /tmp/rt).
//   OV_PORT_BASE=5270 node test/e2e/port-runtime.mjs [name…]     (needs a build: node scripts/build.mjs)
//   PRINT=1 … prints the actual output of each scenario
import { startServer, openBrowser, exec } from './harness.mjs';

// agent1's key and certificate from Node's test fixtures (test/fixtures/keys)
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1FYyCvsg04Jwk9wsQoTtBN+6vVbh3a5Snii3kM1CVtsnM0nz\nc1/9M3x6Y2Psylont/c9xwialsbYhtsMYjiPHN1qljr81ZnVgA5YehH5CJYPhO1Q\nuiWigwPs2m5oT757rtyc6IATJ7FpevJQl87j8XXkAJhMDbao64e+A7TPlHdLpW//\nyMY8aNat62CrvmmnsUq2prnnuqibWtq46weJfAf21Po9Zg3/V0EH0o6PY0Z6eIYk\nxXQZdpPpWc6hNi/64buhDIwNiIQKv+8QNjGy6PXDm1VIp+pX6KOfiSkYE/RadsRI\nAzorfthAP0uqFHzzXi0lVKplzklpV5cJW/TcawIDAQABAoIBAAvbtHfAhpjJVBgt\n15rvaX04MWmZjIugzKRgib/gdq/7FTlcC+iJl85kSUF7tyGl30n62MxgwqFhAX6m\nhQ6HMhbelrFFIhGbwbyhEHfgwROlrcAysKt0pprCgVvBhrnNXYLqdyjU3jz9P3LK\nTY3s0/YMK2uNFdI+PTjKH+Z9Foqn9NZUnUonEDepGyuRO7fLeccWJPv2L4CR4a/5\nku4VbDgVpvVSVRG3PSVzbmxobnpdpl52og+T7tPx1cLnIknPtVljXPWtZdfekh2E\neAp2KxCCHOKzzG3ItBKsVu0woeqEpy8JcoO6LbgmEoVnZpgmtQClbBgef8+i+oGE\nBgW9nmECgYEA8gA63QQuZOUC56N1QXURexN2PogF4wChPaCTFbQSJXvSBkQmbqfL\nqRSD8P0t7GOioPrQK6pDwFf4BJB01AvkDf8Z6DxxOJ7cqIC7LOwDupXocWX7Q0Qk\nO6cwclBVsrDZK00v60uRRpl/a39GW2dx7IiQDkKQndLh3/0TbMIWHNcCgYEA4J6r\nyinZbLpKw2+ezhi4B4GT1bMLoKboJwpZVyNZZCzYR6ZHv+lS7HR/02rcYMZGoYbf\nn7OHwF4SrnUS7vPhG4g2ZsOhKQnMvFSQqpGmK1ZTuoKGAevyvtouhK/DgtLWzGvX\n9fSahiq/UvfXs/z4M11q9Rv9ztPCmG1cwSEHlo0CgYEAogQNZJK8DMhVnYcNpXke\n7uskqtCeQE/Xo06xqkIYNAgloBRYNpUYAGa/vsOBz1UVN/kzDUi8ezVp0oRz8tLT\nJ5u2WIi+tE2HJTiqF3UbOfvK1sCT64DfUSCpip7GAQ/tFNRkVH8PD9kMOYfILsGe\nv+DdsO5Xq5HXrwHb02BNNZkCgYBsl8lt33WiPx5OBfS8pu6xkk+qjPkeHhM2bKZs\nnkZlS9j0KsudWGwirN/vkkYg8zrKdK5AQ0dqFRDrDuasZ3N5IA1M+V88u+QjWK7o\nB6pSYVXxYZDv9OZSpqC+vUrEQLJf+fNakXrzSk9dCT1bYv2Lt6ox/epix7XYg2bI\nZ/OHMQKBgQC2FUGhlndGeugTJaoJ8nhT/0VfRUX/h6sCgSerk5qFr/hNCBV4T022\nx0NDR2yLG6MXyqApJpG6rh3QIDElQoQCNlI3/KJ6JfEfmqrLLN2OigTvA5sE4fGU\nDp/ha8OQAx95EwXuaG7LgARduvOIK3x8qi8KsZoUGJcg2ywurUbkWA==\n-----END RSA PRIVATE KEY-----\n";
const CERT = "-----BEGIN CERTIFICATE-----\nMIID6DCCAtCgAwIBAgIUFH02wcL3Qgben6tfIibXitsApCYwDQYJKoZIhvcNAQEL\nBQAwejELMAkGA1UEBhMCVVMxCzAJBgNVBAgMAkNBMQswCQYDVQQHDAJTRjEPMA0G\nA1UECgwGSm95ZW50MRAwDgYDVQQLDAdOb2RlLmpzMQwwCgYDVQQDDANjYTExIDAe\nBgkqhkiG9w0BCQEWEXJ5QHRpbnljbG91ZHMub3JnMCAXDTIyMDkwMzIxNDAzN1oY\nDzIyOTYwNjE3MjE0MDM3WjB9MQswCQYDVQQGEwJVUzELMAkGA1UECAwCQ0ExCzAJ\nBgNVBAcMAlNGMQ8wDQYDVQQKDAZKb3llbnQxEDAOBgNVBAsMB05vZGUuanMxDzAN\nBgNVBAMMBmFnZW50MTEgMB4GCSqGSIb3DQEJARYRcnlAdGlueWNsb3Vkcy5vcmcw\nggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDUVjIK+yDTgnCT3CxChO0E\n37q9VuHdrlKeKLeQzUJW2yczSfNzX/0zfHpjY+zKWie39z3HCJqWxtiG2wxiOI8c\n3WqWOvzVmdWADlh6EfkIlg+E7VC6JaKDA+zabmhPvnuu3JzogBMnsWl68lCXzuPx\ndeQAmEwNtqjrh74DtM+Ud0ulb//Ixjxo1q3rYKu+aaexSramuee6qJta2rjrB4l8\nB/bU+j1mDf9XQQfSjo9jRnp4hiTFdBl2k+lZzqE2L/rhu6EMjA2IhAq/7xA2MbLo\n9cObVUin6lfoo5+JKRgT9Fp2xEgDOit+2EA/S6oUfPNeLSVUqmXOSWlXlwlb9Nxr\nAgMBAAGjYTBfMF0GCCsGAQUFBwEBBFEwTzAjBggrBgEFBQcwAYYXaHR0cDovL29j\nc3Aubm9kZWpzLm9yZy8wKAYIKwYBBQUHMAKGHGh0dHA6Ly9jYS5ub2RlanMub3Jn\nL2NhLmNlcnQwDQYJKoZIhvcNAQELBQADggEBAMM0mBBjLMt9pYXePtUeNO0VTw9y\nFWCM8nAcAO2kRNwkJwcsispNpkcsHZ5o8Xf5mpCotdvziEWG1hyxwU6nAWyNOLcN\nG0a0KUfbMO3B6ZYe1GwPDjXaQnv75SkAdxgX5zOzca3xnhITcjUUGjQ0fbDfwFV5\nix8mnzvfXjDONdEznVa7PFcN6QliFUMwR/h8pCRHtE5+a10OSPeJSrGG+FtrGnRW\nG1IJUv6oiGF/MvWCr84REVgc1j78xomGANJIu2hN7bnD1nEMON6em8IfnDOUtynV\n9wfWTqiQYD5Zifj6WcGa0aAHMuetyFG4lIfMAHmd3gaKpks7j9l26LwRPvI=\n-----END CERTIFICATE-----\n";

const scenarios = [
  {
    name: 'os',
    cmd: `node -p "const os = require('os'); [os.release(), os.version(), os.machine(), process.report.getReport().header.osVersion, process.report.getReport().header.cpus.length === os.cpus().length].join('|')"`,
    expected: '6.8.0-openvessel|#1 SMP OpenVessel|x86_64|#1 SMP OpenVessel|true\n',
  },
  {
    name: 'import-meta',
    files: { 'm.mjs': "console.log(import.meta.dirname, import.meta.filename, Object.keys(import.meta).join());\nconst d = Object.getOwnPropertyDescriptor(import.meta, 'dirname');\nconsole.log(d.writable, d.enumerable, d.configurable);\n" },
    cmd: 'node m.mjs',
    expected: '/tmp/rt /tmp/rt/m.mjs dirname,filename,main,resolve,url\ntrue true true\n',
  },
  {
    name: 'env-file',
    files: { '.env': 'FOO=fromfile\nNODE_OPTIONS=--stack-trace-limit=7\n# comment\nQ="a\\nb"\n' },
    cmd: [
      `node --env-file=.env -p 'process.env.FOO + " " + Error.stackTraceLimit + " " + JSON.stringify(process.env.Q)'`,
      `FOO=outer node --env-file .env -p process.env.FOO`,
      `node --env-file=missing -p 1; echo "exit $?"`,
      `node --env-file-if-exists=missing -p 1 2>&1; echo "exit $?"`,
      // after -p's code the options go on, as in Node
      `node -p 'typeof process.env.FOO' --env-file=.env`,
    ].join('; '),
    expected: 'fromfile 7 "a\\nb"\nouter\nnode: missing: not found\nexit 9\nmissing not found. Continuing without it.\n1\nexit 0\nstring\n',
  },
  {
    name: 'run',
    files: {
      'package.json': JSON.stringify({ scripts: { a: 'echo "$NODE_RUN_SCRIPT_NAME $NODE_RUN_PACKAGE_JSON_PATH $(pwd)"; echo', b: 'exit 3', c: 1 } }),
      'sub/node_modules/.bin/.keep': '',
    },
    cmd: 'cd sub && node --run a -- x "y z"; echo "exit $?"; node --run b; echo "exit $?"; node --run c; echo "exit $?"; node --run nope; echo "exit $?"; cd / && node --run a; echo "exit $?"',
    expected:
      'a /tmp/rt/package.json /tmp/rt\nx y z\nexit 0\nexit 1\nScript "c" is unexpectedly not a string for /tmp/rt/package.json\n\nexit 1\nMissing script: "nope" for /tmp/rt/package.json\n\nAvailable scripts are:\n  a: echo "$NODE_RUN_SCRIPT_NAME $NODE_RUN_PACKAGE_JSON_PATH $(pwd)"; echo\n  b: exit 3\nexit 1\nCan\'t find package.json for directory /\nexit 1\n',
  },
  {
    name: 'options',
    cmd: [
      `node --stack_trace_limit=3 -p 'Error.stackTraceLimit + " " + process.execArgv[0]'`,
      `NODE_OPTIONS=--stack-trace-limit=4 node -p Error.stackTraceLimit`,
      `node --expose_gc --use-strict --max_old_space_size=100 --no-expose-gc -p 1`,
      `node --stack-trace-limit 5 -p 1; echo "exit $?"`,
      `node --expose-gc=1 -p 1; echo "exit $?"`,
      `node --foo_bar -p 1; echo "exit $?"`,
      `node --no-max-http-header-size -p 1; echo "exit $?"`,
      `NODE_OPTIONS=--use-strict node -p 1; echo "exit $?"`,
      `node --watch; echo "exit $?"`,
      `node --prof-process; echo "exit $?"`,
      `node --v8-options | sed -n 2p`,
    ].join('; '),
    expected:
      '3 --stack_trace_limit=3\n4\n1\nError: illegal value for flag --stack-trace-limit of type int\nTry --help for options\nnode: bad option: --stack-trace-limit\nnode: bad option: --harmony-import-attributes\nnode: bad option: --no-harmony-import-assertions\nnode: bad option: --experimental-wasm-imported-strings\nnode: bad option: --experimental-wasm-memory64\nnode: bad option: --experimental-wasm-exnref\nexit 9\nError: illegal value for flag --expose-gc=1 of type bool\nTo set or unset a boolean flag, use --flag or --no-flag.\nTry --help for options\nnode: bad option: --expose-gc=1\nnode: bad option: --harmony-import-attributes\nnode: bad option: --no-harmony-import-assertions\nnode: bad option: --experimental-wasm-imported-strings\nnode: bad option: --experimental-wasm-memory64\nnode: bad option: --experimental-wasm-exnref\nexit 9\nnode: bad option: --foo_bar\nexit 9\nnode: --no-max-http-header-size is an invalid negation because it is not a boolean option\nexit 9\nnode: --use-strict is not allowed in NODE_OPTIONS\nexit 9\nnode: --watch requires specifying a file\nexit 9\nPlease provide a valid isolate file as the final argument.\nexit 1\nThe following syntax for options is accepted (both \'-\' and \'--\' are ok):\n',
  },
  {
    name: 'fetch-https',
    files: {
      'key.pem': KEY,
      'cert.pem': CERT,
      'f.js': "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\nprocess.removeAllListeners('warning');\nprocess.on('warning', () => {});\nconst https = require('https'), http = require('http'), fs = require('fs');\nconst s = https.createServer({ key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') }, (q, r) => r.end(q.headers.host + ' ' + q.url + ' ' + q.headers['user-agent']));\nconst h = http.createServer((q, r) => { if (q.url === '/r') { r.writeHead(302, { location: '/f' }); return r.end(); } r.end('ok ' + q.url); });\ns.listen(443, () => h.listen(8080, async () => {\n  const a = await fetch('https://localhost/x');\n  console.log(a.status, a instanceof Response, await a.text());\n  const b = await fetch('http://localhost:8080/r');\n  console.log(b.status, b.redirected, b.url, await b.text());\n  try { await fetch('http://localhost:8081/'); } catch (e) { console.log(e.message, e.cause.code); }\n  s.close(); s.closeAllConnections(); h.close(); h.closeAllConnections();\n}));\n",
    },
    cmd: 'node f.js',
    expected: '200 true localhost /x node\n200 true http://localhost:8080/f ok /f\nfetch failed ECONNREFUSED\n',
  },
  {
    // clones and the static factories are instances of the global classes (Astro checks an endpoint's
    // result with instanceof Response)
    name: 'fetch-classes',
    files: {
      'c.mjs': "const r = new Response('x', { status: 404 });\nconst q = new Request('http://a.test/', { method: 'POST', body: 'b' });\nconst d = await fetch('data:,hi');\nconsole.log([r.clone(), Response.json({ a: 1 }), Response.error(), Response.redirect('http://a.test/', 302), d, d.clone()].map((x) => x instanceof Response && x.constructor === Response).join(' '));\nconsole.log(q.clone() instanceof Request, await r.clone().text(), await Response.json({ a: 1 }).text(), await q.clone().text());\n",
    },
    cmd: 'node c.mjs',
    expected: 'true true true true true true\ntrue x {"a":1} b\n',
  },
  {
    // (PIPEWRAP: process.stderr, which net's Socket._destroy() looks at, is a pipe)
    name: 'async-hooks',
    files: {
      'h.js': "const ah = require('async_hooks'), fs = require('fs'), net = require('net');\nconst ev = [];\nconst types = new Map();\nconst name = (id) => types.get(id) ?? id;\nah.createHook({\n  init(id, type, trigger) { if (type === 'PROMISE') return; types.set(id, type); ev.push(`init ${type} ${name(trigger)}`); },\n  before(id) { if (types.has(id)) ev.push(`before ${name(id)}`); },\n  after(id) { if (types.has(id)) ev.push(`after ${name(id)}`); },\n  destroy(id) { if (types.has(id)) ev.push(`destroy ${name(id)}`); },\n}).enable();\nfs.stat(__filename, () => {\n  ev.push(`stat cb in ${name(ah.executionAsyncId())} ${ah.executionAsyncResource().constructor.name}`);\n  setImmediate(() => {\n    fs.writeSync(1, ev.join('\\n') + '\\n');\n    ev.length = 0;\n    const srv = net.createServer((c) => { ev.push(`connection in ${name(ah.executionAsyncId())}`); c.end(); srv.close(); }).listen(0, () => {\n      const c = net.connect(srv.address().port, () => ev.push(`connect in ${name(ah.executionAsyncId())}`));\n      c.resume();\n      c.on('close', () => setImmediate(() => {\n        const inits = ev.filter((l) => /^init (TCP|PIPE|GETADDR|SHUTDOWN)/.test(l));\n        const other = ev.filter((l) => / in /.test(l)).sort();\n        fs.writeSync(1, [...new Set(inits)].sort().concat(other).join('\\n') + '\\n');\n      }));\n    });\n  });\n});\n",
    },
    cmd: 'node h.js',
    expected:
      'init FSREQCALLBACK 1\nbefore FSREQCALLBACK\nstat cb in FSREQCALLBACK FSReqCallback\ninit Immediate FSREQCALLBACK\nafter FSREQCALLBACK\ndestroy FSREQCALLBACK\nbefore Immediate\ninit GETADDRINFOREQWRAP TCPWRAP\ninit PIPEWRAP TickObject\ninit SHUTDOWNWRAP TCPWRAP\ninit TCPCONNECTWRAP TCPWRAP\ninit TCPSERVERWRAP Immediate\ninit TCPWRAP TCPSERVERWRAP\ninit TCPWRAP TickObject\nconnect in TCPCONNECTWRAP\nconnection in TCPSERVERWRAP\n',
  },
];

const only = process.argv.slice(2);
const srv = await startServer();
const { browser, page } = await openBrowser();
let failed = 0;
try {
  await exec(page, 'mkdir -p /etc/openvessel && echo port > /etc/openvessel/node', { cwd: '/' });
  for (const s of scenarios) {
    if (only.length && !only.includes(s.name)) continue;
    await exec(page, 'rm -rf /tmp/rt && mkdir -p /tmp/rt/sub/node_modules/.bin', { cwd: '/' });
    for (const [p, c] of Object.entries(s.files ?? {})) await page.evaluate(([p, c]) => window.ov.fs.writeFile(p, c), [`/tmp/rt/${p}`, c]);
    const r = await exec(page, s.cmd, { cwd: '/tmp/rt', timeout: 60000 });
    const ok = r.output === s.expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${s.name} (${r.ms}ms)`);
    if (!ok || process.env.PRINT) {
      const got = r.output.split('\n');
      const want = s.expected.split('\n');
      for (let i = 0; i < Math.max(got.length, want.length); i++) {
        if (got[i] === want[i]) {
          if (process.env.PRINT) console.log(`    ${got[i]}`);
          continue;
        }
        if (want[i] !== undefined) console.log(`  - ${want[i]}`);
        if (got[i] !== undefined) console.log(`  + ${got[i]}`);
      }
    }
  }
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
