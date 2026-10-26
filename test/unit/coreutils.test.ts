// The command-line programs checked against GNU coreutils / grep / sed / diffutils.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, run } from './helpers.ts';

const sh = async (script: string) => run(makeKernel(), script);
const out = async (script: string) => (await sh(script)).stdout;

test('options: wrappers stop at the command, digits are options', async () => {
  assert.equal(await out('mkdir d; touch f; printf "d\\nf\\n" | xargs stat -c %F'), 'directory\nregular empty file\n');
  assert.equal(await out('touch a b; ls -1'), 'a\nb\n');
  assert.equal(await out("printf 'a b\\0c\\0' | xargs -0 -n1 echo"), 'a b\nc\n');
  assert.equal(await out("echo \"'a b' c\\\\ d\" | xargs -n1 echo"), 'a b\nc d\n');
  assert.equal(await out('env -u HOME sh -c \'echo "[$HOME]"\''), '[]\n');
  let r = await sh('env nonexistent-cmd');
  assert.equal(r.code, 127);
  r = await sh('echo x | xargs nonexistent-cmd');
  assert.equal(r.code, 127);
  r = await sh('echo x | xargs sh -c "exit 3"');
  assert.equal(r.code, 123);
  assert.equal(await out('nice -n 5 echo hi; nohup echo there'), 'hi\nthere\n');
});

test('timeout: own options, the command keeps its options, durations, 124', async () => {
  let r = await sh("timeout 2 sh -c 'exit 3'");
  assert.equal(r.code, 3);
  r = await sh('timeout 0.05 sleep 5');
  assert.equal(r.code, 124);
  r = await sh('timeout -s KILL 0.05 sleep 5');
  assert.equal(r.code, 137);
  r = await sh('timeout --preserve-status 0.05 sleep 5');
  assert.equal(r.code, 143);
  r = await sh('timeout 1m echo -n ok');
  assert.equal(r.stdout, 'ok');
  r = await sh('timeout 1x true');
  assert.equal(r.code, 125);
  r = await sh('timeout 1 nonexistent-cmd');
  assert.equal(r.code, 127);
});

test('seq', async () => {
  assert.equal(await out('seq -s, 3'), '1,2,3\n');
  assert.equal(await out('seq -s , 3'), '1,2,3\n');
  assert.equal(await out('seq -w 8 10'), '08\n09\n10\n');
  assert.equal(await out('seq -2 2 2'), '-2\n0\n2\n');
  assert.equal(await out('seq 0 0.1 0.3'), '0.0\n0.1\n0.2\n0.3\n');
  assert.equal(await out('seq 3 1'), '');
  assert.equal(await out('seq -f %03g 2'), '001\n002\n');
  assert.equal((await sh('seq 1 0 3')).code, 1);
});

test('chmod: -x is a mode, = sets only the named classes', async () => {
  const st = 'stat -c %a f';
  assert.equal(await out(`touch f; chmod 755 f; chmod -x f; ${st}`), '644\n');
  assert.equal(await out(`touch f; chmod 777 f; chmod -w,-r f; ${st}`), '133\n');
  assert.equal(await out(`touch f; chmod 777 f; chmod a-w f; ${st}`), '555\n');
  assert.equal(await out(`touch f; chmod 755 f; chmod u=rw f; ${st}`), '655\n');
  assert.equal(await out(`touch f; chmod 640 f; chmod g=u f; ${st}`), '660\n');
  assert.equal(await out(`mkdir d; touch d/f; chmod 600 d/f; chmod -R a+X d; stat -c %a d d/f`), '755\n600\n');
  assert.equal((await sh('touch f; chmod q+x f')).code, 1);
});

test('tr', async () => {
  assert.equal(await out("echo 'hello, world' | tr -c 'a-z\\n' _"), 'hello__world\n');
  assert.equal(await out("echo 'aabbcc' | tr -s a-c"), 'abc\n');
  assert.equal(await out("echo 'hello' | tr -d l"), 'heo\n');
  assert.equal(await out("echo 'a1b22c' | tr -cd '0-9\\n'"), '122\n');
  assert.equal(await out("echo 'hello' | tr a-y b-z"), 'ifmmp\n');
  assert.equal(await out("echo 'a  b   c' | tr -s ' ' '_'"), 'a_b_c\n');
});

test('find: -empty with a relative start, -type, -exec +', async () => {
  assert.equal(await out('mkdir -p d/e d/f; touch d/f/x d/g; find d -empty | sort'), 'd/e\nd/f/x\nd/g\n');
  assert.equal(await out('mkdir -p d/e; echo x > d/f; cd d && find . -empty'), './e\n');
  assert.equal(await out('mkdir d; mkfifo d/p; touch d/f; find d -type p'), 'd/p\n');
  assert.equal(await out('mkdir d; touch d/a d/b; find d -type f -exec echo {} +'), 'd/a d/b\n');
  assert.equal(await out('mkdir d; touch d/a; find d -type f -exec echo "<{}>" \\;'), '<d/a>\n');
});

test('kill: -s, -0, -l, -NAME, -NUM, process groups', async () => {
  assert.equal(await out('sleep 5 & kill -s TERM $!; wait $!; echo $?'), '143\n');
  assert.equal(await out('sleep 5 & p=$!; kill -0 $p && echo alive; kill -9 $p; wait $p; echo $?; kill -0 $p 2>/dev/null || echo gone'), 'alive\n137\ngone\n');
  assert.equal(await out('sleep 5 & kill -SIGINT $!; wait $!; echo $?'), '130\n');
  assert.equal(await out('kill -l 15; kill -l 137; kill -l TERM'), 'TERM\nKILL\n15\n');
  assert.match(await out('kill -l'), /^HUP INT QUIT /);
  let r = await sh('kill -s FOO 1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid signal specification/);
  r = await sh('kill 99999');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No such process/);
});

test('date: %Z from TZ, formats', async () => {
  assert.equal(await out('TZ=Asia/Tokyo date -d @0 "+%Y-%m-%d %H:%M %Z %z"'), '1970-01-01 09:00 JST +0900\n');
  assert.equal(await out('TZ=America/New_York date -d @0 +%Z'), 'EST\n');
  assert.equal(await out('TZ=UTC date -d @0'), 'Thu Jan  1 00:00:00 UTC 1970\n');
  assert.equal(await out('TZ=JST-9 date -d @0 +%H%Z'), '09JST\n');
  assert.equal(await out('TZ=Asia/Tokyo date -u -d @0 +%H%Z'), '00UTC\n');
  assert.equal(await out('TZ=Asia/Tokyo date -d 2026-01-02 +%s'), '1767279600\n');
  assert.equal(await out('TZ=UTC date -d @86400 "+%j %a %A %b %e %-d %_m|%I%p"'), '002 Fri Friday Jan  2 2  1|12AM\n');
  assert.equal(await out('TZ=UTC date -d @0 -I; TZ=UTC date -d @0 -Iseconds'), '1970-01-01\n1970-01-01T00:00:00+00:00\n');
});

test('ls -l on a directory has one total line, none for file operands', async () => {
  let r = await out('mkdir d; touch d/a; ls -l d');
  assert.equal(r.split('\n').filter((l) => l.startsWith('total')).length, 1);
  r = await out('touch f; ls -l f');
  assert.ok(!r.includes('total'));
});

test('grep: context, several -e, -o', async () => {
  const f = 'printf "a\\nb\\nc\\nd\\ne\\nf\\ng\\n" > f; ';
  assert.equal(await out(f + 'grep -A1 c f'), 'c\nd\n');
  assert.equal(await out(f + 'grep -B1 c f'), 'b\nc\n');
  assert.equal(await out(f + 'grep -C1 -e b -e f f'), 'a\nb\nc\n--\ne\nf\ng\n');
  assert.equal(await out(f + 'grep -n -A1 a f'), '1:a\n2-b\n');
  assert.equal(await out(f + 'grep -e a -e g f'), 'a\ng\n');
  assert.equal(await out("echo 'abc' | grep -o 'x*'"), '');
  assert.equal(await out("echo 'a1b22' | grep -o '[0-9]*'"), '1\n22\n');
  assert.equal(await out("echo 'aXb' | grep 'a.b'"), 'aXb\n');
  assert.equal(await out("echo 'ab' | grep 'a\\|x'"), 'ab\n');
  assert.equal((await sh('grep x /nonexistent')).code, 2);
});

test('sed: combined options, escapes', async () => {
  assert.equal(await out("printf 'a\\nb\\n' | sed -ne '2p'"), 'b\n');
  assert.equal(await out("printf 'a\\nb\\n' | sed -n -e 1p"), 'a\n');
  assert.equal(await out("echo 'hello world' | sed -E 's/(\\w+) (\\w+)/\\2 \\1/'"), 'world hello\n');
  assert.equal(await out("echo 'hello' | sed 's/l/\\U&/g'"), 'heLLo\n');
  assert.equal(await out("echo 'a/b' | sed 's/\\//|/'"), 'a|b\n');
  assert.equal(await out("echo f > f; sed -i.bak 's/f/g/' f; cat f f.bak"), 'g\nf\n');
});

test('tail and head', async () => {
  assert.equal(await out("printf 'abcdef' | tail -c +3"), 'cdef');
  assert.equal(await out("printf 'abcdef' | tail -c 2"), 'ef');
  assert.equal(await out("printf '1\\n2\\n3\\n' | tail -n +2"), '2\n3\n');
  assert.equal(await out("printf '1\\n2\\n3\\n' | tail -1"), '3\n');
  assert.equal(await out("printf '1\\n2\\n3\\n' | head -2"), '1\n2\n');
});

test('diff: normal and unified formats', async () => {
  const files = "printf 'a\\nb\\nc\\nd\\n' > x; printf 'a\\nB\\nc\\nd\\ne\\n' > y; ";
  let r = await sh(files + 'diff x y');
  assert.equal(r.stdout, '2c2\n< b\n---\n> B\n4a5\n> e\n');
  assert.equal(r.code, 1);
  r = await sh(files + 'diff -u x y | tail -n +3');
  assert.equal(r.stdout, '@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e\n');
  r = await sh(files + 'diff -U0 x y | tail -n +3');
  assert.equal(r.stdout, '@@ -2 +2 @@\n-b\n+B\n@@ -4,0 +5 @@\n+e\n');
  r = await sh("printf 'a\\nb\\n' > x; printf 'b\\n' > y; diff x y");
  assert.equal(r.stdout, '1d0\n< a\n');
  r = await sh("printf 'a' > x; printf 'a\\n' > y; diff x y");
  assert.equal(r.stdout, '1c1\n< a\n\\ No newline at end of file\n---\n> a\n');
  r = await sh('echo a > x; echo a > y; diff x y');
  assert.equal(r.stdout, '');
  assert.equal(r.code, 0);
  r = await sh('echo a > x; diff x missing');
  assert.equal(r.code, 2);
  r = await sh(files + 'diff -u x y | head -2');
  assert.match(r.stdout, /^--- x\t\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{9} [+-]\d{4}\n\+\+\+ y\t/);
});

test('file and stat on special files', async () => {
  assert.equal(await out('mkfifo p; file p'), 'p: fifo (named pipe)\n');
  assert.equal(await out('file /dev/null'), '/dev/null: character special (1/3)\n');
  assert.equal(await out('echo hi > t; : > e; file t e; file -b t'), 't: ASCII text\ne: empty\nASCII text\n');
  assert.equal(await out('file missing'), "missing: cannot open `missing' (No such file or directory)\n");
  assert.equal(await out('mkfifo p; stat -c %F p'), 'fifo\n');
  assert.equal(await out('stat -f -c %T /'), 'tmpfs\n');
  assert.match(await out('stat -f /'), /Type: tmpfs/);
  assert.equal(await out('echo hi > f; stat --printf "%s %n\\n" f'), '3 f\n');
});

test('rm refuses / and . ..', async () => {
  let r = await sh('rm -rf /; ls / | grep -c .');
  assert.match(r.stderr, /dangerous to operate recursively on '\/'/);
  assert.ok(Number(r.stdout) > 0);
  r = await sh('mkdir d; cd d; rm -rf .');
  assert.match(r.stderr, /refusing to remove '\.' or '\.\.'/);
  assert.equal(r.code, 1);
});

test('tty without a terminal', async () => {
  const r = await sh('tty');
  assert.equal(r.stdout, 'not a tty\n');
  assert.equal(r.code, 1);
});

test('curl -i / -I show the origin server status line and headers', async () => {
  const { setNpmFetch } = await import('../../src/kernel/npm/cli.ts');
  const { installCurl } = await import('../../src/kernel/curl.ts');
  // what the runtime service worker's proxy answers: its own headers, the origin's in x-ov-*
  setNpmFetch(async () =>
    new Response('hello', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'cache-control': 'no-store',
        'x-ov-status': '201',
        'x-ov-status-text': encodeURIComponent('Created'),
        'x-ov-rh': encodeURIComponent(JSON.stringify([['content-type', 'application/json'], ['x-origin', '1']])),
      },
    }),
  );
  const k = makeKernel();
  installCurl(k);
  let r = await run(k, 'curl -si http://example.com/');
  assert.equal(r.stdout, 'HTTP/1.1 201 Created\r\ncontent-type: application/json\r\nx-origin: 1\r\n\r\nhello');
  r = await run(k, 'curl -sI http://example.com/');
  assert.equal(r.stdout, 'HTTP/1.1 201 Created\r\ncontent-type: application/json\r\nx-origin: 1\r\n\r\n');
  r = await run(k, 'curl -so out -w "%{http_code} %{content_type}\\n" http://example.com/; cat out');
  assert.equal(r.stdout, '201 application/json\nhello');
});
