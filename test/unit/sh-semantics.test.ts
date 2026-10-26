// Shell semantics checked against bash 5 / POSIX sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, run } from './helpers.ts';

const sh = async (script: string) => run(makeKernel(), script);

test('$! is the pid of the background job; kill and wait use it', async () => {
  const r = await sh(`sleep 10 & p=$!
case $p in ''|*[!0-9]*) echo "bad pid '$p'";; esac
kill -0 $p && echo alive
kill $p; wait $p; echo "status $?"
(exit 3) & q=$!; sleep 0.05; wait $q; echo "late $?"
wait $q; echo "again $?"`);
  assert.equal(r.stdout, 'alive\nstatus 143\nlate 3\nagain 127\n');
});

test('wait with no operands waits for every job', async () => {
  const r = await sh('for i in 1 2 3; do (sleep 0.0$i; echo $i) & done; wait; echo done');
  assert.equal(r.stdout, '1\n2\n3\ndone\n');
});

test('background jobs keep $$ and see the shell state', async () => {
  const r = await sh('x=5; f() { echo "f $x $1"; }; f a & wait; echo "$$" > /tmp/p; (echo $$) > /tmp/q & wait; [ "$(cat /tmp/p)" = "$(cat /tmp/q)" ] && echo same');
  assert.equal(r.stdout, 'f 5 a\nsame\n');
});

test('EXIT traps run on exit, in subshells and on signals', async () => {
  let r = await sh("trap 'echo bye $?' EXIT; echo hi; exit 4");
  assert.equal(r.stdout, 'hi\nbye 4\n');
  assert.equal(r.code, 4);
  r = await sh("trap 'echo bye' 0; false");
  assert.equal(r.stdout, 'bye\n');
  r = await sh("(trap 'echo sub' EXIT; echo in); echo out");
  assert.equal(r.stdout, 'in\nsub\nout\n');
  r = await sh("trap 'echo t; exit 7' EXIT; true");
  assert.equal(r.code, 7);
  r = await sh("trap 'echo got TERM' TERM; kill -TERM $$; echo after");
  assert.equal(r.stdout, 'got TERM\nafter\n');
  r = await sh("trap 'echo cleanup' EXIT; kill $$; sleep 1; echo not-reached");
  assert.equal(r.stdout, 'cleanup\n');
  assert.equal(r.code, 143);
  r = await sh("trap 'echo usr1' USR1; (sleep 0.05; kill -USR1 $$) & sleep 10 & wait $!; echo \"wait $?\"; kill $!");
  assert.equal(r.stdout, 'usr1\nwait 138\n');
  r = await sh("trap '' INT; trap; trap - INT; trap -p INT; trap 'echo x' HUP; trap -p");
  assert.equal(r.stdout, "trap -- '' SIGINT\ntrap -- 'echo x' SIGHUP\n");
});

test('ERR trap', async () => {
  const r = await sh("trap 'echo err $?' ERR; false; true; if false; then :; fi; echo end");
  assert.equal(r.stdout, 'err 1\nend\n');
});

test('assignment-only commands: status of the last command substitution, else 0', async () => {
  const r = await sh('x=$(false); y=1; echo $?; z=$(exit 4) w=1; echo $?; set -e; a=$(false) || true; b=1; echo ok');
  assert.equal(r.stdout, '0\n4\nok\n');
});

test('errors abandon the current line only (bash)', async () => {
  const r = await sh(`readonly x=1
x=2; echo not-run
echo next $?
echo $((1/0)); echo not-run
echo next2
let 'y = 1/0'; echo "let $?"
f() { x=3; echo not-run; }; f; echo not-run
eval 'x=4'; echo "eval $?"
( x=5; echo not-run ); echo "sub $?"`);
  assert.equal(r.stdout, 'next 1\nnext2\nlet 1\neval 1\nsub 1\n');
  assert.match(r.stderr, /x: readonly variable/);
  assert.match(r.stderr, /division by 0/);
});

test('${p:?} and set -u exit a non-interactive shell (status 1)', async () => {
  let r = await sh('echo ${nope:?not set}; echo after');
  assert.equal(r.stdout, '');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nope: not set/);
  r = await sh('set -u; echo $nope; echo after');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nope: unbound variable/);
});

test('a syntax error further down does not stop the lines before it', async () => {
  const r = await sh('echo one\nif then\necho two');
  assert.equal(r.stdout, 'one\n');
  assert.equal(r.code, 2);
});

test('a glob ending in / matches directories only', async () => {
  const r = await sh('mkdir -p g/d1 g/d2; touch g/f1; cd g; echo */; echo d*/ ; echo f*/');
  assert.equal(r.stdout, 'd1/ d2/\nd1/ d2/\nf*/\n');
});

test('sh accepts grouped options: -ec, -eo pipefail, -xc', async () => {
  const k = makeKernel();
  let r = await run(k, '', undefined, ['sh', '-ec', 'false; echo no']);
  assert.equal(r.stdout, '');
  assert.equal(r.code, 1);
  r = await run(k, '', undefined, ['sh', '-c', 'echo $0 $1', 'name', 'arg']);
  assert.equal(r.stdout, 'name arg\n');
  r = await run(k, '', undefined, ['sh', '-eo', 'pipefail', '-c', 'false | true; echo no']);
  assert.equal(r.code, 1);
  r = await run(k, '', undefined, ['sh', '-xc', 'echo hi']);
  assert.equal(r.stdout, 'hi\n');
  assert.equal(r.stderr, '+ echo hi\n');
  r = await sh('set -euo pipefail; echo "$-"; false | true; echo no');
  assert.equal(r.code, 1);
});

test('aliases can hold several commands, pipes and reserved words', async () => {
  const r = await sh(`alias two='echo a; echo b' up='tr a-z A-Z' ll='echo ll:'
two
echo x | up
ll one
alias ls='ls -1' sudo='sudo '
alias loop='for i in 1 2; do echo $i; done'
loop
alias e=echo; alias q='e '
q e
e "e"`);
  assert.equal(r.stdout, 'a\nb\nX\nll: one\n1\n2\necho\ne\n');
});

test('case: ;& falls through, ;;& tests the next patterns', async () => {
  const r = await sh(`case a in a) echo 1;& b) echo 2;; c) echo 3;; esac
case ab in a*) echo x;;& *b) echo y;;& c) echo z;; *) echo w;; esac`);
  assert.equal(r.stdout, '1\n2\nx\ny\nw\n');
});

test("$'...' escapes", async () => {
  const k = makeKernel();
  const r = await run(k, `printf %s $'\\a\\b\\f\\v\\101\\x41\\u00e9\\cA\\q\\'\\0101' > /tmp/e`);
  assert.equal(r.stderr, '');
  assert.equal(new TextDecoder().decode(k.vfs.readFile('/tmp/e')), "\x07\b\f\vAAé\x01\\q'\x08" + '1');
});

test('[[ ]] file tests and unknown operators', async () => {
  const r = await sh(`mkfifo p; touch f; chmod 4755 f
[[ -p p ]] && echo fifo
[[ -p f ]] || echo notfifo
[[ -u f ]] && echo setuid
[[ -O f && -G f ]] && echo mine
[[ -S f ]] || echo nosock
[[ -c /dev/null ]] && echo chardev
[[ -k f ]] || echo nosticky
[[ -q f ]]; echo "unknown $?"
[[ -o errexit ]] || echo noerrexit
[[ 1+1 -eq 2 ]] && echo arith
x='-f'; [[ $x ]] && echo nonempty`);
  assert.equal(r.stdout, 'fifo\nnotfifo\nsetuid\nmine\nnosock\nchardev\nnosticky\nunknown 2\nnoerrexit\narith\nnonempty\n');
});

test('[[ =~ ]] uses ERE; quoted parts match literally; BASH_REMATCH', async () => {
  const r = await sh(`[[ 'a.c' =~ ^a"."c$ ]] && echo lit1
[[ 'abc' =~ ^a"."c$ ]] || echo lit2
re='^([a-z]+)-([0-9]{2,})$'; [[ foo-123 =~ $re ]] && echo "\${BASH_REMATCH[0]} \${BASH_REMATCH[1]} \${BASH_REMATCH[2]} \${#BASH_REMATCH[@]}"
[[ x1 =~ [[:digit:]] ]] && echo class
[[ 'a\\d' =~ a\\\\d ]] && echo bs
[[ 'ad' =~ '\\d' ]] || echo quoted-bs
[[ a =~ '(' ]] || echo quoted-paren
[[ a =~ ( ]]; echo "bad $?"`);
  assert.equal(r.stdout, 'lit1\nlit2\nfoo-123 foo 123 3\nclass\nbs\nquoted-bs\nquoted-paren\nbad 2\n');
});

test('[[ =~ ]]: unquoted ( ) | belong to the regex, blanks too inside ( )', async () => {
  const r = await sh(`[[ foo123 =~ ([a-z]+)([0-9]+) ]] && echo "\${BASH_REMATCH[1]} \${BASH_REMATCH[2]}"
[[ xb =~ ^(a|x)b$ ]] && echo alt
[[ 'a b' =~ (a b) ]] && echo blank
[[ (ab =~ a) && -n x ]] && echo group`);
  assert.equal(r.stdout, 'foo 123\nalt\nblank\ngroup\n');
});

test('umask: octal and symbolic', async () => {
  const r = await sh('umask 022; umask u=rwx,g=rx,o=; umask; umask -S; umask g+w; umask; umask a-w; umask; umask 077; (umask 0); umask; umask 022; umask -p');
  assert.equal(r.stdout, '0027\nu=rwx,g=rx,o=\n0007\n0227\n0077\numask 0022\n');
});

test('redirections create files with the umask', async () => {
  const r = await sh('umask 077; echo > f; stat -c %a f; umask 022; echo > g; stat -c %a g');
  assert.equal(r.stdout, '600\n644\n');
});

test('arithmetic is 64-bit signed and wraps', async () => {
  const r = await sh(`echo $(( 9223372036854775807 + 1 )) $(( 4000000000 * 4000000000 )) $(( -9223372036854775808 / -1 ))
echo $(( 1 << 63 )) $(( 1 << 64 )) $(( 7 % -3 )) $(( -7 % 3 )) $(( 2 ** 62 )) $(( 2 ** 64 ))
echo $(( 16#ff )) $(( 0x10 )) $(( 010 )) $(( 64#_ )) $(( 1 ? 2 : 1/0 )) $(( 0 && 1/0 )) $(( x = 3, x * 2 ))
echo $(( 2 ** -1 ))`);
  assert.equal(r.stdout, '-9223372036854775808 -2446744073709551616 -9223372036854775808\n-9223372036854775808 1 1 -1 4611686018427387904 0\n255 16 8 63 2 0 6\n');
  assert.match(r.stderr, /exponent less than 0/);
});

test('"$@" with no arguments is no word, "$@x" is x', async () => {
  const k = makeKernel();
  const r = await run(k, 'f() { printf "[%s]" "$@"; echo; printf "[%s]" "$@x"; echo; set -- "a b"; printf "[%s]" "$@"; echo; }; f');
  assert.equal(r.stdout, '[]\n[x]\n[a b]\n');
});
