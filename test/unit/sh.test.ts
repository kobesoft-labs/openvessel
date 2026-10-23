import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKernel, run } from './helpers.ts';

test('echo and variables', async () => {
  const k = makeKernel();
  const r = await run(k, 'A=hello; echo "$A world" ${B:-dflt} $((1+2*3))');
  assert.equal(r.stdout, 'hello world dflt 7\n');
});

test('pipes, redirects, globs', async () => {
  const k = makeKernel();
  const r = await run(k, 'mkdir -p d && cd d && echo b > b.txt && echo a > a.txt && ls *.txt | sort -r | tr a-z A-Z; cat a.txt b.txt > c; wc -l < c');
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'B.TXT\nA.TXT\n2\n');
});

test('control flow and functions', async () => {
  const k = makeKernel();
  const r = await run(
    k,
    `f() { local x=$1; echo "f:$x"; return 3; }
for i in 1 2 3; do if [ $i -eq 2 ]; then continue; fi; f $i; done
f z || echo "rc=$?"
case foo.js in *.ts) echo ts;; *.js) echo js;; esac
n=0; while [ $n -lt 3 ]; do n=$((n+1)); done; echo $n
cat <<END
heredoc $n
END
echo $(echo nested $(echo deep))
x="a b  c"; set -- $x; echo $#
[[ abc == a* && 1 -lt 2 ]] && echo dbl`,
  );
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'f:1\nf:3\nf:z\nrc=3\njs\n3\nheredoc 3\nnested deep\n3\ndbl\n');
});

test('exit codes and command not found', async () => {
  const k = makeKernel();
  const r = await run(k, 'nosuchcmd; echo $?; false && echo no; true || echo no; (exit 4); echo $?');
  assert.equal(r.stdout, '127\n4\n');
  assert.match(r.stderr, /nosuchcmd: command not found/);
});

test('sed grep find', async () => {
  const k = makeKernel();
  const r = await run(
    k,
    `mkdir -p p/q; echo "hello world" > p/q/x.txt; echo foo > p/y.md
find p -name '*.txt'; grep -rn world p; echo hello | sed 's/l\\+/L/g'; echo 'a=1' | sed -E 's/(a)=([0-9])/\\2\\1/'`,
  );
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'p/q/x.txt\np/q/x.txt:1:hello world\nheLo\n1a\n');
});
