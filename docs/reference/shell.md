# Shell and commands

[日本語](shell.ja.md)

This page specifies the shell `sh` (also installed as `bash` and `dash`) and every command-line program
built into the kernel: the grammar the parser accepts, expansions, redirections, built-in commands,
options, exit statuses, interactive mode, and each program with its options and its differences from
GNU coreutils.

## Overview

The shell and the programs on this page are *kernel programs*: TypeScript functions that run inside the
kernel worker, not separate Web Workers. Only `node` (and what it starts) runs in a worker of its own
(see [Processes](processes.md) and [Node.js runtime](nodejs-runtime.md)). A kernel program still is a
real process: it has a pid, a parent, file descriptors, an environment and an exit status, and it shows
up in `ps`.

| Item | Value |
|---|---|
| Source | `src/kernel/sh/parse.ts` (parser), `interp.ts` (interpreter, built-ins, line editor), `arith.ts`, `pattern.ts`, `printf.ts`, `test.ts`; programs in `src/kernel/coreutils.ts` and `src/kernel/curl.ts` |
| Shell names | `/bin/sh`, `/bin/bash`, `/bin/dash` — all the same program. `bash` is not GNU bash: it accepts the same subset described here. |
| How programs are installed | Each program is an executable file (mode `0755`) whose content is `#!/ov/builtin <name>`. The kernel recognises that interpreter line and runs the built-in function. |
| Locations | Shells and coreutils in `/bin`; `curl`, `wget`, `env` (a second copy, for `#!/usr/bin/env` lines), `node`, `nodejs` (a symlink to `node`), `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `bun`, `bunx`, `corepack` in `/usr/bin` |
| Default `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `vessel.exec(line)` | runs `/bin/sh -c <line>` and resolves with `{ code, output }` (see [Host API](host-api.md)) |
| Terminal | `vessel.spawn('sh', [], { terminal: { cols, rows } })` gives `sh` a TTY on fds 0–2, which makes it interactive |

Processes started by the host get the kernel's default environment merged with the `env` option, and
the working directory `/home/user` unless `cwd` is given (the directory is created if missing). The
default environment is:

| Variable | Value |
|---|---|
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/home/user` |
| `USER`, `LOGNAME` | `user` |
| `SHELL` | `/bin/sh` |
| `TERM` | `xterm-256color` |
| `LANG` | `en_US.UTF-8` |
| `TMPDIR` | `/tmp` |
| `HOSTNAME` | `openvessel` |
| `NAPI_RS_FORCE_WASI` | `1` |

## Invoking sh

```text
sh [options] [-c command [name [arg...]]]
sh [options] script [arg...]
sh [options]                     # reads commands from stdin, or interactive on a TTY
```

Options are read left to right until the first argument that is not one of these:

| Option | Effect |
|---|---|
| `-c command` | Run `command`. Option parsing stops here. The next argument becomes `$0` (default `sh`), the rest `$1`… |
| `-i` | Interactive mode, even if stdin is not a TTY. |
| `-e`, `-u`, `-x`, `-f`, `-a` and `+` forms | Same as `set` (see [Shell options](#shell-options)). Letters may be combined, also with `c`, `i` and `o` (`-eu`, `+ex`, `-ec '…'`, `-eo pipefail`). |
| `-o name`, `+o name` | Same as `set -o name` / `set +o name`. |
| `-l`, `--login`, `--norc`, `--noprofile`, `-s` | Accepted and ignored. |
| `--` | Ends the options. |

Anything else (including `--version`) is taken as the script file name.

How the shell decides what to run:

| Situation | Behaviour |
|---|---|
| `-c` given | Parses and runs the string. Exit status is that of the last command. |
| A script argument | Reads the file (relative to the working directory, no `PATH` search). If the first line starts with `#!` it is dropped. `$0` is the file name as given, `$1`… the remaining arguments. A missing file prints `sh: <file>: No such file or directory` and exits with 127. |
| No arguments, stdin not a TTY, no `-i` | Reads all of stdin, then parses and runs it as one script. |
| No arguments and stdin is a TTY, or `-i` | Runs `$HOME/.shrc` (errors are ignored), then starts the interactive loop (see [Interactive mode](#interactive-mode)). |

The file `/home/user/.shrc` is created at boot with:

```sh
alias ll='ls -l'
alias la='ls -la'
```

`.shrc` is read only by interactive shells, so these aliases do not exist in `sh -c` or in scripts.

Input is parsed and run one complete command (normally one line) at a time, as bash does. A syntax
error is reported as `<name>: <message>` (where `<name>` is `$0`, or the script name) and the shell
stops with status 2; the lines before it have already run.

## Grammar

The parser (`src/kernel/sh/parse.ts`) implements a practical subset of the POSIX shell grammar plus some
bash extensions. Each complete command (up to the end of its line; a compound command may span
several lines) is parsed and then run before the next one is parsed.

### Lists and pipelines

| Syntax | Meaning |
|---|---|
| `a ; b`, newline | Run `a`, then `b`. |
| `a & b` | Run `a` in the background (see [Background jobs](#subshells-pipelines-and-background-jobs)), then `b`. |
| `a && b` | Run `b` only if `a` exited with 0. |
| `a \|\| b` | Run `b` only if `a` exited non-zero. |
| `a \| b` | Pipeline: `a`'s stdout feeds `b`'s stdin. Elements run concurrently. |
| `a \|& b` | Same, with `a`'s stderr also sent into the pipe (shorthand for `a 2>&1 \| b`). |
| `! pipeline` | Inverts the exit status (0 becomes 1, anything else 0). `!` must be followed by a blank. |

`&&` and `||` have equal precedence and associate left to right. A newline may follow `|`, `&&` and `||`
(the command continues on the next line). `\` followed by a newline is removed everywhere outside single
quotes (line continuation). `#` at the start of a word starts a comment to the end of the line.

### Compound commands

| Syntax | Notes |
|---|---|
| `{ list; }` | Brace group, runs in the current shell. `{` and `}` are reserved words: they must be separate words, and `}` must be at the start of a command (after `;` or a newline). |
| `( list )` | Subshell: runs in a copy of the shell state (variables, functions, aliases, options, cwd, fds). Changes don't reach the parent. |
| `if list; then list; [elif list; then list;]... [else list;] fi` | |
| `while list; do list; done` | |
| `until list; do list; done` | |
| `for name [in word...]; do list; done` | Without `in`, iterates over `"$@"`. The words undergo full expansion (splitting and globbing). |
| `case word in [(]pattern[\|pattern]...) list ;; ... esac` | Shell patterns (see [Pattern matching](#pattern-matching)). The first matching item runs; the status is 0 if nothing matches. The last `;;` before `esac` may be omitted. An item may end with `;&` (run the next item's list too, without testing its patterns) or `;;&` (go on testing the following patterns). |
| `(( expression ))` | Arithmetic command: status 0 if the expression is non-zero, else 1. The text is expanded like a double-quoted string first. |
| `[[ expression ]]` | Conditional command (see [`[[ ]]`](#conditional-command)). |

Redirections may follow any compound command (`while ...; done < file`, `{ ...; } 2>&1`).

### Functions

```sh
name() compound-command
function name compound-command
function name() compound-command
```

- With `name()`, `name` must be a literal word. With the `function` keyword, the name may contain
  letters, digits, `_`, `.`, `:` and `-` (it must start with a letter or `_`).
- The body may be any command, normally a `{ ...; }` group.
- Calling a function sets `$1`… and `$#` for the call (`$0` is unchanged) and restores them afterwards.
  `local` and `declare` variables are restored when the function returns.
- `return [n]` leaves the function with status `n & 255` (default: the last status).
- Nesting deeper than 200 calls fails with `maximum function nesting level exceeded`.
- Lookup order for a command name: function, then built-in, then a program file (see
  [Command lookup](#command-lookup)).

### Reserved words

`if then else elif fi do done case esac while until for in { } ! function [[ ]]` are recognised only in
command position (and `in`/`do` where the grammar expects them). `select`, `coproc` and `time` are not
reserved words (`time` is a program, see [time](#time-and-timeout)).

### Not supported

These are confirmed by the parser and interpreter:

| Feature | What happens |
|---|---|
| Brace expansion `{a,b}`, `{1..3}` | Not performed; the word stays literal (`echo {a,b}` prints `{a,b}`). |
| Process substitution `<(cmd)`, `>(cmd)` | Syntax error: `syntax error near unexpected token '('`. |
| Arrays | `name=(a b c)` stores the text between the parentheses (up to the first `)`, trimmed, quotes not processed) as one string; `${name[i]}` ignores the index; `name+=(x)` appends the text without a separator. The one exception is `BASH_REMATCH`. |
| Indirect expansion `${!name}` | `bad substitution` (syntax error, status 2). |
| `${parameter@op}`, `${!prefix*}` | `bad substitution`. |
| Extended globs `@(…)`, `!(…)`, `+(…)` | Syntax error: `(` is a metacharacter in a word. |
| Job control | No `fg`, `bg` (command not found); `jobs` prints nothing. |
| `PS2` | The continuation prompt is always `> `. |

## Quoting

| Form | Meaning |
|---|---|
| `'...'` | Literal; no character is special. Cannot contain `'`. |
| `"..."` | `$`, `` ` `` and `\` stay special. `\` escapes only `$`, `` ` ``, `"`, `\` and newline (removed); before any other character it is kept. |
| `\c` (outside quotes) | Quotes the next character. `\` + newline is a line continuation. |
| `$'...'` | ANSI-C quoting. Escapes: `\a` `\b` `\f` `\n` `\r` `\t` `\v`, `\e`/`\E` (ESC), `\nnn` (1–3 octal digits), `\xHH` (1–2 hex digits), `\uHHHH` (1–4 hex digits), `\UHHHHHHHH` (1–8 hex digits), `\cX` (control character). Any other `\c` yields `c` (so `\\` → `\`, `\'` → `'`). |

Quoted text is never split or globbed. An empty quoted string (`""`, `''`) produces one empty field.

## Expansion

Each word of a simple command is expanded in this order: tilde, parameter, command substitution and
arithmetic (left to right), then field splitting of the unquoted results, then pathname expansion of the
fields that contain unquoted glob characters, then quote removal. Assignment values, redirection targets,
`case` words and the operands of `[[ ]]` are expanded without field splitting and without globbing.

Alias substitution happens earlier, while the command is parsed (see [Aliases](#aliases)).

### Tilde expansion

At the start of a word, `~` followed by the end of the word, `/` or a metacharacter is replaced:

| Form | Result |
|---|---|
| `~` | `$HOME` (`/home/user` if unset) |
| `~root` | `/root` |
| `~name` | `/home/name` (the password file is not consulted) |

The result is not split or globbed. `~+` and `~-` are not supported. Only a `~` at the start of a word
is expanded (`PATH=~/bin` works, the second `~` in `a:~/b` does not).

### Parameters and variables

Variable names match `[A-Za-z_][A-Za-z0-9_]*`. `$name` takes the longest such name; `$1`–`$9` take one
digit (`$10` is `$1` followed by `0`); use `${10}` for higher positions.

Special parameters:

| Parameter | Value |
|---|---|
| `$?` | Status of the last command. |
| `$$` | Pid of the shell process. Subshells, pipeline elements and command substitutions run in the same process, and a background job (a process of its own) keeps its parent's `$$`, as in bash. |
| `$!` | Pid of the last background job's process, usable with `kill` and `wait`. Empty before the first `&`. |
| `$#` | Number of positional parameters. |
| `$0` | Shell or script name (`sh`, the `-c` name argument, or the script path). |
| `$1`… | Positional parameters. |
| `$@`, `$*` | All positional parameters (see [Word splitting](#word-splitting)). |
| `$-` | Current option letters, from `e`, `x`, `u`, `i` (in that order). `f`, `a` and `pipefail` are not shown. |

Variables the shell sets or reads:

| Variable | Meaning |
|---|---|
| `PWD` | Current directory. Always reflects the shell's cwd; exported. Assigning `PWD` changes the shell's notion of the cwd. |
| `OLDPWD` | Previous directory, set (and exported) by `cd`. |
| `PPID` | Parent pid of the shell process. |
| `IFS` | Field separators, default space, tab, newline. Not exported. |
| `HOME` | Used by `~`, `cd` without arguments, the prompt's `~` and `.shrc`. |
| `PATH` | Program search path (also used by `source`, `type`, `command -v`, `which`, tab completion). |
| `CDPATH` | Colon-separated directories searched by `cd` for relative names that don't start with `.`. |
| `RANDOM` | A new random integer 0–32767 on every read. |
| `SECONDS` | Whole seconds since the shell process started. |
| `PS1` | Interactive prompt (see [Prompt](#prompt)). |
| `PS4` | Prefix of `set -x` trace lines, default `+ `. |
| `REPLY` | Default variable of `read`. |
| `OPTIND`, `OPTARG` | Used by `getopts`. |
| `BASH_REMATCH` | Set by `[[ string =~ regex ]]`: `$BASH_REMATCH` and `${BASH_REMATCH[0]}` are the whole match, `${BASH_REMATCH[n]}` the n-th group, `${#BASH_REMATCH[@]}` the number of elements. |
| `__OV_OPTSUB`, `__OV_DIRSTACK` | Internal state of `getopts` and `pushd`/`popd` (visible in `set`). |

Assignments:

- `name=value` and `name+=value` (appends to the current value). Several may precede a command.
- With no command word, the assignments are made in the current shell. The status is that of the last
  command substitution in them, or 0 if there is none (`x=$(false); y=1` gives 0 for `y=1`).
- Before an external program, they go only into that program's environment.
- Before a function or a regular built-in, they are set for the duration of the call and then restored.
- Before a special built-in (`:` `.` `break` `continue` `eval` `exec` `exit` `export` `readonly`
  `return` `set` `shift` `trap` `unset` `source`), they remain set.
- Assigning a `readonly` variable prints `sh: <name>: readonly variable` with status 1. In an
  assignment-only command the rest of the current line is skipped and the shell goes on with the next
  line (bash's behaviour; an interactive shell gets a new prompt); inside a built-in (`export`, `read`,
  …) the built-in fails with status 1.

### Parameter expansion

`parameter` below is a name, a positional number, or one of `@ * # ? $ ! -`.

| Form | Result |
|---|---|
| `${parameter}` | Value. |
| `${#parameter}` | Length in UTF-16 code units. `${#@}` and `${#*}` give the number of positional parameters. |
| `${p:-word}` / `${p-word}` | `word` if `p` is unset or empty / unset; otherwise the value. |
| `${p:=word}` / `${p=word}` | Same, and assigns `word` to `p`. |
| `${p:?word}` / `${p?word}` | If unset or empty / unset: prints `sh: p: word` (or `sh: p: parameter null or not set`) and exits a non-interactive shell with status 1. An interactive shell does not exit: the command line is abandoned with status 1. |
| `${p:+word}` / `${p+word}` | `word` if `p` is set and non-empty / set; otherwise empty. |
| `${p#pattern}` / `${p##pattern}` | Removes the shortest / longest matching prefix. |
| `${p%pattern}` / `${p%%pattern}` | Removes the shortest / longest matching suffix. |
| `${p/pattern/string}` | Replaces the first match (longest match at the leftmost position). |
| `${p//pattern/string}` | Replaces every match. |
| `${p/#pattern/string}` / `${p/%pattern/string}` | Replaces a match anchored at the start / end. |
| `${p^}` / `${p^^}` | Uppercases the first character / all characters. A pattern argument is ignored. |
| `${p,}` / `${p,,}` | Lowercases the first character / all characters. |
| `${p:offset}` / `${p:offset:length}` | Substring. A negative offset counts from the end (write `${p: -3}`; `${p:-3}` is the default-value form). A negative length ends that many characters before the end. Offset and length are converted with `Number()` after expansion — they are not arithmetic expressions; a non-number counts as 0. For `@`/`*` this takes a substring of the joined string, not a slice of the parameters. |
| `${name[index]}` | The index is ignored: same as `${name}`. |

Patterns in `#`, `%` and `/` forms are shell patterns; quoted parts match literally. In `word` the usual
expansions apply. When `set -u` is on, expanding an unset variable (other than the special parameters)
prints `sh: name: unbound variable` and exits a non-interactive shell with status 1 (an interactive
shell abandons the command line instead).

### Command substitution

`$(commands)` and `` `commands` `` run the commands in a copy of the shell (in the same process) with
stdout captured. Trailing newlines are removed. Unquoted, the result is subject to field splitting and
globbing. `$?` is set to the substitution's status. Inside backquotes, `\$`, `` \` `` and `\\` are
unescaped before parsing. `$((` always starts an arithmetic expansion.

### Arithmetic expansion

`$(( expression ))` is replaced by the decimal value. The expression is first expanded like a
double-quoted string (so `$x` and `$(cmd)` work), then evaluated by `src/kernel/sh/arith.ts`.

Operands:

| Operand | Example |
|---|---|
| Decimal | `42` |
| Octal (leading `0`) | `010` = 8; `08` is an error |
| Hexadecimal | `0x1f` |
| `base#digits` (base 2–64) | `2#101` = 5, `36#z` = 35; above 36 the digits are `0-9a-zA-Z@_` (`64#_` = 63) |
| Variable name | Unset or empty = 0. A value that is not a number is evaluated as an expression; a value that is a variable name is followed (up to 8 levels). |

Operators, from highest to lowest precedence:

| Operators | Notes |
|---|---|
| `( )` | grouping |
| `x++ x--` `++x --x` | on variables only |
| `+ - ! ~` (unary) | |
| `**` | right-associative |
| `* / %` | `/` truncates toward zero; `/` and `%` by zero fail with `division by 0` |
| `+ -` | |
| `<< >>` | |
| `< <= > >=` | result 1 or 0 |
| `== !=` | |
| `&` | |
| `^` | |
| `\|` | |
| `&&` | the right operand is evaluated only if the left one is non-zero |
| `\|\|` | the right operand is evaluated only if the left one is zero |
| `?:` | only the chosen branch is evaluated |
| `= += -= *= /= %= <<= >>= &= ^= \|= **=` | assignment to a variable |
| `,` | value of the last expression |

Arithmetic is on 64-bit signed integers with wrap-around, as in bash: `9223372036854775807+1` and
`2**63` give `-9223372036854775808`, `2147483647*2` = `4294967294`, `1<<33` = `8589934592`.

An error inside `$(( ))` (bad syntax, division by zero) prints `sh: <expression>: <message>`, sets
status 1 and skips the rest of the current line (the shell goes on with the next line). In `(( ))` it
prints `sh: ((: <message>` and the command returns 1. In `let` it prints `sh: let: <expression>:
<message>` and `let` returns 1.

### Word splitting

Unquoted results of parameter expansion, command substitution and arithmetic expansion are split into
fields at characters of `IFS` (default space, tab, newline; unset `IFS` means the default):

- runs of IFS whitespace (space, tab, newline) separate fields and are trimmed at the ends;
- each other IFS character ends a field, so adjacent ones produce empty fields (`a::b` with `IFS=:` gives
  `a`, empty, `b`);
- `IFS=''` disables splitting;
- text that was quoted inside the same word is never split.

`"$@"` expands to one field per positional parameter (none if there are none); `"$*"` to one field joined
with the first character of `IFS` (nothing if `IFS` is empty). Unquoted `$@` and `$*` give one field per
parameter, each then split.

### Pathname expansion

After splitting, every field that contains an unquoted `*`, `?` or `[` is matched against the file
system. Matching is done per path component.

| Pattern | Matches |
|---|---|
| `*` | any string not containing `/` |
| `?` | any one character except `/` |
| `[abc]`, `[a-z]` | one character from the set |
| `[!abc]`, `[^abc]` | one character not in the set |
| `[[:class:]]` | `alpha`, `digit`, `alnum`, `upper`, `lower`, `space`, `blank`, `punct`, `xdigit`, `word` |
| `**` (a whole component) | zero or more directories, at any depth (directories starting with `.` are skipped) |
| `\c` or quoted text | the literal character |

- Names starting with `.` match only if the pattern component starts with `.`; `.` and `..` themselves
  are not listed by `readdir` and never match.
- Results are sorted (by UTF-16 code unit). A pattern ending in `/` matches directories only (and
  symbolic links to directories), each printed with the `/` (`*/` gives `d1/`).
- If nothing matches, the word is left unchanged (`echo *.nomatch` prints `*.nomatch`). There is no
  `nullglob`/`failglob`.
- `set -f` (or `set -o noglob`) turns pathname expansion off.

### Pattern matching

`case`, `[[ x == pattern ]]` and the `#`/`%`/`/` parameter forms use the same pattern syntax as globbing,
except that `*` and `?` also match `/` and leading dots need no special treatment. A `[` without a closing
`]` matches itself.

### Aliases

`alias name=value` defines an alias. While a command is parsed, an unquoted word in command position
that is an alias name is replaced by the alias text, which is then parsed in its place. Consequences:

- The value may hold anything the grammar allows: several commands (`alias x='a; b'`), pipes
  (`alias y='sort |'`), reserved words.
- An alias is not expanded again inside its own text. If the value ends in a blank, the next word is
  checked for an alias too.
- A line is parsed before it runs, so an alias defined on a line takes effect from the next line on
  (`alias x=…; x` on one line doesn't use it), as in bash. Aliases are expanded in scripts and `sh -c`
  too (as POSIX sh does; bash needs `shopt -s expand_aliases` there).
- Aliases defined in `$HOME/.shrc` (`ll`, `la` by default) exist only in interactive shells.

## Redirection

A redirection may be preceded by a single-digit file descriptor number (`0`–`9`), written directly
before the operator (`2>`). Redirections are applied left to right. The target word is expanded without
splitting or globbing (`> *.txt` creates a file named `*.txt`).

| Operator | Default fd | Effect |
|---|---|---|
| `< file` | 0 | open for reading |
| `> file` | 1 | open for writing, create, truncate |
| `>\| file` | 1 | same as `>` (there is no `noclobber`) |
| `>> file` | 1 | open for appending, create |
| `<> file` | 0 | open for reading and writing, create (no truncation) |
| `&> file`, `>& file` | 1 and 2 | stdout and stderr to the file (truncate) |
| `&>> file` | 1 and 2 | stdout and stderr appended to the file |
| `n>&m`, `n<&m` | 1 / 0 | make `n` a copy of `m` |
| `n>&-`, `n<&-` | 1 / 0 | close `n` |
| `<< word`, `<<- word` | 0 | here-document |
| `<<< word` | 0 | here-string: the expanded word plus a newline |

Errors print `sh: <target>: No such file or directory` (or `Is a directory`, `Permission denied`, or
`<n>: Bad file descriptor` for a duplication of a closed fd) and the command fails with status 1 without
running. `n<&word` with a non-numeric word is `ambiguous redirect`.

`exec` with redirections and no command applies them to the shell itself, permanently:

```sh
exec 3>/tmp/log      # open fd 3
echo hello >&3
exec 3>&-            # close it
exec 2>/dev/null     # silence stderr for the rest of the script
```

### Here-documents

```sh
cat <<EOF
home is $HOME, today is $(date +%F)
EOF

cat <<'EOF'
nothing is expanded: $HOME `cmd`
EOF

cat <<-EOF
	leading tabs are removed from each line and from the delimiter line
	EOF
```

- The body starts on the line after the command and ends at a line equal to the delimiter. Several
  here-documents on one line are read in order. At end of input the body simply ends.
- If any part of the delimiter word is quoted (`'EOF'`, `"EOF"`, `\EOF`, `E"O"F`), the body is literal.
  Otherwise parameter expansion, command substitution and arithmetic expansion are performed, and `\`
  escapes `$`, `` ` ``, `\` and newline (as inside double quotes).
- `<<-` strips leading tab characters (not spaces).
- The body is written into a pipe before the command starts; there is no size limit.

## Conditional expressions

### test and [

`test expr` and `[ expr ]` (built-ins, also installed as `/bin/test` and `/bin/[`) evaluate:

| Expression | True if |
|---|---|
| `-e f`, `-a f` | `f` exists |
| `-f f` | regular file |
| `-d f` | directory |
| `-L f`, `-h f` | symbolic link (not followed) |
| `-p f` | FIFO |
| `-c f` | character device |
| `-s f` | size greater than zero |
| `-S f`, `-b f` | socket, block device |
| `-r f`, `-w f`, `-x f` | read / write / execute permission for uid 1000 (the owner, group or other bits, whichever apply) |
| `-u f`, `-g f`, `-k f` | setuid, setgid, sticky bit set |
| `-O f`, `-G f` | owned by uid / gid 1000 |
| `-N f` | modified since last read (mtime later than atime) |
| `-o name` | shell option `name` is on |
| `-t fd` | `fd` is a TTY |
| `-z s` / `-n s` | `s` is empty / non-empty |
| `-v name` | variable `name` is set |
| `s` | `s` is non-empty |
| `a = b`, `a == b`, `a != b` | string equality (no patterns) |
| `a < b`, `a > b` | string order (UTF-16) — quote them in `[ ]` |
| `a -eq/-ne/-lt/-le/-gt/-ge b` | integer comparison |
| `a -nt b` / `a -ot b` | modification time newer / older (a missing file counts as oldest) |
| `a -ef b` | same inode |
| `! e`, `e1 -a e2`, `e1 -o e2`, `( e )` | not, and, or, grouping (`-a` binds tighter than `-o`) |

No arguments: false (1). Status 2 with a message for `sh: test: <x>: integer expression expected`,
`sh: test: too many arguments`, and `sh: [: missing ']'`.

### Conditional command

The words between `[[` and `]]` are expanded without splitting or globbing. Supported:

| Expression | Meaning |
|---|---|
| `a == pattern`, `a = pattern` | shell pattern match; quoted parts of the pattern are literal |
| `a != pattern` | no match |
| `a =~ regex` | POSIX extended regular expression search (bracket classes such as `[[:digit:]]`, back-references are not ERE). Quoted parts of the regex match literally (`[[ $v =~ ^a"."b ]]`); unquoted `( ) \| < >` belong to the regex, and blanks too inside parentheses. Sets `BASH_REMATCH`. An invalid regex gives status 2. |
| `a < b`, `a > b` | string order |
| `-eq -ne -lt -gt -le -ge -nt -ot` | as in `test` |
| every unary operator of `test` + operand | as in `test` |
| `!`, `&&`, `\|\|`, `( )` | not, and, or, grouping |
| `word` | true if non-empty |

An unknown unary operator followed by an operand is an error (`sh: [[: unexpected argument … to
conditional unary operator`, status 2). Otherwise the status is 0 or 1.

## Running commands

### Command lookup

For a simple command, after expansion and alias substitution:

1. `exec` with no arguments: applies the redirections to the shell.
2. A shell function with that name.
3. A built-in (see [Built-in commands](#built-in-commands)).
4. A program: if the name contains `/` it is resolved against the cwd; otherwise each `PATH` entry is
   searched for a regular file with an execute bit. If `PATH` has no match but the name is a kernel
   program (`ls`, `sh`, `npm`, …), that program still runs.

How the kernel runs a program file (`planExec` in `src/kernel/kernel.ts`):

| File starts with | Runs |
|---|---|
| `#!/ov/builtin name` | the kernel program `name` (`node` starts a Node.js process) |
| `#!/usr/bin/env [-S] [VAR=val...] interp args` (or `/bin/env`) | `interp` looked up on `PATH`; `VAR=val` words are skipped (not applied) |
| `#!` + interpreter named `node`, `nodejs`, `bun` or `deno` | Node.js with the interpreter's arguments, then the file |
| `#!` + any other interpreter | that interpreter with the file as its argument (up to 8 levels, then `ELOOP`) |
| no `#!`, name ends in `.js`, `.cjs` or `.mjs` | Node.js with the file |
| no `#!`, anything else | `sh file` (like POSIX `ENOEXEC` handling) |

Which Node.js runtime is started (the ported or the legacy one) is decided per process start by
`/etc/openvessel/node`; see [Node.js runtime](nodejs-runtime.md).

### Exit status

| Status | Meaning |
|---|---|
| 0–255 | exit status of the command (`exit n` and `return n` use `n & 255`, so `exit 300` gives 44) |
| 1 | redirection failure; assignment to a readonly variable; an arithmetic error; `${p:?}`; `set -u` violation |
| 2 | syntax error; misuse of `test`/`[`/`[[`/`printf`/`source` |
| 126 | program file found but not executable (`sh: X: Permission denied`), or another spawn error |
| 127 | command not found (`sh: X: command not found`); script file of `sh file` missing |
| 128 + n | terminated by signal `n`: 130 SIGINT, 137 SIGKILL, 141 SIGPIPE, 143 SIGTERM |
| 130 | the shell itself was interrupted between commands |
| 141 | a built-in wrote to a pipe with no reader (EPIPE) |

In interactive mode, when a program is terminated by a signal other than SIGINT and SIGPIPE, the shell
prints the signal name (for example `SIGTERM`).

### Environment

A program receives the shell's exported variables (those inherited from the environment, set with
`export`, `declare -x`, or while `set -a` is on), plus `PWD`, plus any prefix assignments of the command.
`OLDPWD` is exported by `cd`. Built-ins and functions see all variables.

### Subshells, pipelines and background jobs

The shell does not create a kernel process for a subshell, a pipeline element or a command
substitution: each runs as a copy of the shell state inside the same shell process, concurrently where
applicable. A background job is a process of its own. Programs started from any of them are separate
processes.

- **Subshell `( )`** — `exit` inside it only ends the subshell.
- **Pipeline** — every element runs concurrently with its own copy; the status is that of the last
  element, or with `set -o pipefail` that of the rightmost element that failed. In an interactive shell
  a pipeline is one job: its programs share one process group, which is the terminal's foreground group
  while the pipeline runs. In a non-interactive shell programs stay in the shell's process group, so a
  ^C sent to the group reaches them. `exit` in a pipeline element only ends that element.
- **Background `&`** — the command runs in a new process, a copy of the shell (a simple command naming
  a program is executed directly in that process); the shell continues immediately with status 0.
  Stdin is not redirected. `$!` is that process's pid, so `kill $!` works. `wait` (no arguments) waits
  for all background jobs and returns 0. `wait PID` waits for that job and returns its status, also
  when it has already finished; the status is collected once, and a second `wait` on the same pid (or a
  pid that is not a child of this shell) prints `sh: wait: pid N is not a child of this shell` and
  returns 127. A trapped signal interrupts `wait` with status 128 + the signal number.

```sh
npm run build > build.log 2>&1 &
job=$!
echo "building..."
wait "$job"; echo "build exited with $?"
```

## Shell options

`set [-+]letters`, `set -o name` / `set +o name`, or the same flags on the `sh` command line:

| Letter | `-o` name | Effect |
|---|---|---|
| `-e` | `errexit` | Exit when a command fails. Not applied to the condition of `if`/`elif`/`while`/`until`, to commands of an `&&`/`\|\|` list other than the last, or to a `!` pipeline. Applies inside functions. |
| `-u` | `nounset` | Expanding an unset variable is an error (status 1; a non-interactive shell exits, an interactive one abandons the line). |
| `-x` | `xtrace` | Before each simple command, print `$PS4` (default `+ `) and the expanded assignments and words to stderr, single-quoting words that contain characters other than `A-Za-z0-9_./=:@%+-`. |
| `-f` | `noglob` | Disable pathname expansion. |
| `-a` | `allexport` | Export every variable that is assigned. |
| — | `pipefail` | A pipeline's status is that of the rightmost failing element. |

Other letters and `-o` names are accepted and ignored (for example `set -v`, `set -o vi`, `set -n` have
no effect). `set` with no arguments prints every variable as `name='value'`, sorted. `set -- args` and
`set args` (first argument not starting with `-`/`+`) replace the positional parameters.

## Interactive mode

### Prompt

Before each command the shell writes the prompt to stderr. If `PS1` is set, these escapes are replaced
(no others): `\w` (cwd, with `$HOME` shown as `~`), `\u` (always `user`), `\h` (hostname, `openvessel`),
`\$` (`$`). If `PS1` is unset the prompt is

```text
\e[1;32muser@openvessel\e[0m:\e[1;34m~/app\e[0m$ 
```

i.e. a green `user@openvessel`, a colon, the blue cwd, and `$ `. When a line is syntactically incomplete
(an open quote, `if` without `fi`, a trailing `|`), the shell prints `> ` and appends the next line.

Commands entered: blank lines are ignored; errors print `sh: <message>` and set the status; `exit` or
end of input ends the shell (end of input prints `exit` and returns the last status). `${p:?}` and
`set -u` errors don't end an interactive shell.

### Line editing

On a TTY the shell switches the terminal to raw mode without echo while reading a line, and back to
cooked mode with echo afterwards (also after each foreground program).

| Key | Action |
|---|---|
| Enter (CR or LF) | accept the line |
| Left / Right | move one character |
| Up / Down | previous / next history entry (the line being edited is kept) |
| Home, Ctrl-A | start of line (Home: `ESC [ H`, `ESC O H`, `ESC [ 1 ~`) |
| End, Ctrl-E | end of line (End: `ESC [ F`, `ESC O F`, `ESC [ 4 ~`) |
| Backspace (DEL or Ctrl-H) | delete the character before the cursor |
| Delete (`ESC [ 3 ~`) | delete the character under the cursor |
| Ctrl-D | on an empty line: end of input; otherwise delete the character under the cursor |
| Ctrl-K | delete to the end of the line |
| Ctrl-U | delete to the start of the line |
| Ctrl-W | delete the word before the cursor (words are separated by spaces) |
| Alt-B, Ctrl-Left | move one word left |
| Alt-F, Ctrl-Right | move one word right |
| Ctrl-L | clear the screen and redraw the line |
| Ctrl-C | print `^C`, discard the line, set status 130, new prompt |
| Tab | completion (below) |

Other control characters are ignored. Without a TTY (`sh -i` with piped input), lines are read as plain
text and the prompt is still written to stderr.

### History and completion

- History is kept in memory for the life of the shell (not saved to a file). A line is added unless it is
  equal to the previous entry. `history` lists it with numbers.
- Tab completes the word before the cursor. For the first word of the line (without `/`): built-in
  names, function names and the names of all files in the `PATH` directories. Otherwise: file names
  relative to the cwd (`~/` is understood); hidden files only when the typed prefix starts with `.`;
  directories get a trailing `/`.
- One candidate: it is inserted, followed by a space (no space after a directory). Several: the common
  prefix is inserted; if nothing could be added, the candidates are listed below the line.

### Signals

The interactive shell ignores SIGINT, SIGTSTP, SIGQUIT and SIGWINCH (unless trapped). Each job it starts
(a program, or all the programs of a pipeline) gets its own process group, which becomes the terminal's
foreground group while the job runs, so Ctrl-C reaches the job and not the shell. See
[Processes](processes.md) for the TTY.

### Traps

`trap 'action' SIGNAL...` sets a handler; `trap '' SIGNAL` ignores the signal; `trap - SIGNAL` restores
the default. Signals are names with or without `SIG` (`INT`, `SIGTERM`) or numbers; `EXIT` (or `0`) and
`ERR` are pseudo-signals.

- `EXIT` runs when the shell exits (end of input, `exit`, `set -e`, an error that ends the shell) and
  before it dies of a signal; in a subshell it runs when the subshell ends. `exit` inside the action
  sets the final status; `$?` in the action is the exit status.
- `ERR` runs after a command fails, where `set -e` would apply.
- A trapped signal received by the shell (from `kill`, or ^C on the terminal) runs its action at the
  next command boundary, and interrupts a `wait`. An ignored signal is dropped. Untrapped SIGTERM,
  SIGHUP… end a non-interactive shell (after the `EXIT` trap) with status 128 + n.
- `trap` with no operands or `trap -p [SIGNAL...]` prints the handlers as `trap -- 'action' SIGNAME`;
  `trap -l` lists the signals.

## Built-in commands

Built-ins run inside the shell. `echo`, `printf`, `test`, `[`, `true`, `false` and `pwd` also exist as
programs in `/bin` with the same behaviour (useful with `xargs`, `find -exec`, `env`).

| Built-in | Options and operands | Notes |
|---|---|---|
| `:` | any | status 0 |
| `true`, `false` | any | status 0 / 1 |
| `.`, `source` | `file [args]` | Runs `file` in the current shell. A name without `/` is searched on `PATH` (executable files only), then in the cwd. With `args`, positional parameters are replaced during the run. Missing operand: status 2; missing file: `No such file or directory`, status 1. `return` ends the file. |
| `alias` | `[name[=value]...]` | No operands: list as `alias name='value'`. `name` alone prints that alias. |
| `unalias` | `name...` | `-a` is not supported (treated as a name). |
| `break`, `continue` | `[n]` | Leave / continue the `n`-th enclosing loop. Outside a loop in a non-interactive shell, `break`/`continue` end the shell with status 0. |
| `builtin` | `name [args]` | Run the built-in `name`; status 1 if there is none. |
| `cd` | `[-L\|-P] [dir\|-]` | No operand: `$HOME` (or `/`). `-`: `$OLDPWD`, and prints it. `CDPATH` is used for names not starting with `/` or `.`. `-L`/`-P` are accepted and ignored (symlinks are resolved by the file system in either case). Sets `OLDPWD` (exported), `PWD` and the process cwd. Errors: `No such file or directory`, `Not a directory`. |
| `command` | `[-v\|-V] name...` / `name [args]` | `-v`/`-V`: print the name for built-ins and functions, the path for programs; status 1 if any is not found (aliases are not reported). Otherwise run `name` bypassing shell functions. |
| `declare`, `typeset` | `[-x] [name[=value]...]` | Inside a function the names are local (restored on return). `-x` exports. Other options are ignored; no operands prints nothing. |
| `echo` | `[-neE]... [args]` | See [echo](#echo). |
| `eval` | `args` | Joins the arguments with spaces and runs the result. |
| `exec` | `[cmd [args]]` | Without a command: redirections apply to the shell. With a command: runs it like any command (a program becomes a child process) and then exits the shell with its status. It is not a real `execve`: the program gets a new pid. |
| `exit` | `[n]` | Exit with `n & 255` (default: last status). In a subshell or pipeline element, only that part ends. |
| `export` | `[-p] [-n] [name[=value]...]` | No operands or `-p`: list as `export name='value'`, sorted. `-n` is ignored. An invalid name: ``sh: export: `x': not a valid identifier``. |
| `getopts` | `optstring name [args]` | See [getopts](#getopts). |
| `hash` | any | no-op, status 0 |
| `history` | — | Prints the history: number right-aligned in 5 columns, two spaces, the line. |
| `jobs`, `times` | any | no-op, status 0, no output |
| `let` | `expr...` | Evaluates each arithmetic expression; status 0 if the last is non-zero, 1 if it is zero or an expression fails (`sh: let: <expr>: <message>`). |
| `local` | `[name[=value]...]` | Saves `name` and restores it when the function returns. Without a value an unset variable is set to the empty string. Options are ignored. Outside a function it is a plain assignment. |
| `printf` | `[-v var] format [args]` | See [printf](#printf). |
| `pushd` | `[dir]` | Push the cwd on a directory stack, then `cd dir` (no operand: `cd $HOME`). Prints nothing. |
| `popd` | — | `cd` to the top of the stack and pop it; status 1 if empty. Prints nothing. There is no `dirs`. |
| `pwd` | any | Prints the shell's cwd. `-L`/`-P` are ignored. |
| `read` | see [read](#read) | |
| `readonly` | `[-p] [name[=value]...]` | Marks names readonly (assigning first if `=value`). No operands prints nothing. |
| `return` | `[n]` | Return from a function or a sourced file; at the top level of `sh -c` or a script, ends it with `n`. |
| `set` | see [Shell options](#shell-options) | |
| `shift` | `[n]` | Drop `n` (default 1) positional parameters; status 1 (nothing shifted) if `n` exceeds `$#`. |
| `test`, `[` | see [test and [](#test-and-) | |
| `trap` | `[-lp] [action] [signal...]` | See [Traps](#traps). |
| `type` | `name...` | Prints `X is a function`, ``X is aliased to `v'``, `X is a shell builtin`, or `X is /path` (checked in that order); `sh: type: X: not found` and status 1 otherwise. Options are ignored. |
| `ulimit` | `[-a] [-n] [value]` | Only the open-files limit (`-n`) exists. It bounds how many Node.js threads a process can start (each thread counts 8 descriptors on top of a base of 30). Default 1024, inherited by children; `unlimited` = 1048576. `-a` prints `open files (-n) N`. Any other option prints `unlimited` and setting it has no effect. |
| `umask` | `[-p] [-S] [mode]` | Prints the mask as 4 octal digits (`-S` symbolically, `u=rwx,g=rx,o=rx`; `-p` as `umask 0022`), or sets it from an octal number or a symbolic mode (`u=rwx,g=rx,o=`, `g+w`, `a-w`: the permissions to keep). The mask applies to the shell's redirections and the programs it starts; a subshell's `umask` stays in the subshell. |
| `unset` | `[-f] [-v] name...` | Removes variables, or functions after `-f`. A readonly variable gives `sh: unset: X: readonly variable`, status 1. |
| `wait` | `[pid...]` | See [Background jobs](#subshells-pipelines-and-background-jobs). A pid that isn't a child gives 127. |

### echo

```text
echo [-n] [-e] [-E] [arg...]
```

Leading arguments that consist only of `-` followed by the letters `n`, `e`, `E` are options (`-ne`,
`-en`, `-nE`). `-n` drops the trailing newline. `-e` enables escapes, `-E` disables them (the default).
`--` is printed like any argument. Escapes with `-e`: `\a \b \e \f \n \r \t \v \\`, `\0nnn` (octal, up
to 3 digits), `\xHH`; `\c` stops output (no newline).

### printf

```text
printf [-v var] format [argument...]
```

- Conversions: `%d %i` (integer, truncated), `%u` (absolute value), `%o`, `%x`, `%X`, `%e %E` (JavaScript
  exponent format, e.g. `1.234500e+3`), `%f %F`, `%g %G`, `%c` (first character), `%s`, `%b` (argument
  with backslash escapes), `%q` (shell-quoted), `%%`.
- Flags `-` (left-align), `0` (zero-pad numbers), `+`, space (sign for `%d`/`%i`), `#` (`0x` prefix for
  `%x` only). Width and precision may be numbers or `*`. Precision truncates `%s`/`%b`.
- Escapes in the format: `\a \b \e \f \n \r \t \v \\ \" \'`, `\NNN` and `\0NNN` (octal), `\xHH`, `\c`
  (stop output).
- Numeric arguments: `'c` or `"c` gives the character code; text that is not a number is read with
  `parseFloat`, else 0 — there is no error.
- The format is reused while arguments remain; missing arguments are empty / 0.
- `-v var` stores the result in `var` instead of printing. No format: status 2 with
  `usage: printf format [arguments]`.

### read

```text
read [-r] [-p prompt] [-d delim] [-n count] [-N count] [-s] [-t x] [-u x] [-a x] [name...]
```

- Reads from fd 0 one byte at a time up to the delimiter (default newline), then decodes UTF-8.
- Without `-r`, `\` escapes the next character and `\` + newline continues the line.
- `-p` writes the prompt to stderr. `-d ''` uses NUL as the delimiter. `-n`/`-N` stop after `count`
  bytes. `-s` is accepted (no effect). `-t`, `-u` and `-a` take an argument and are ignored.
- No names: the whole line goes to `REPLY`, untrimmed. One name: the line with leading and trailing IFS
  whitespace removed. Several names: the line is split at IFS characters; the last name gets the rest.
- Status 1 at end of input when nothing was read (a final line without a newline still returns 0).

### getopts

```sh
while getopts "ab:" opt; do
  case $opt in
    a) echo "flag a" ;;
    b) echo "b=$OPTARG" ;;
    ?) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
```

Parses `args` (default: the positional parameters) starting at `OPTIND` (default 1). An option followed by
`:` in `optstring` takes an argument (attached or the next word) into `OPTARG`; a missing argument gives
an empty `OPTARG`. An unknown option sets `name` to `?` without printing anything. At the first
non-option, `-`, or `--` (which is consumed), `name` is set to `?` and the status is 1.

## Programs

All programs below are installed in `/bin` unless noted. Unless a command says otherwise, options are
parsed by a small getopt in `src/kernel/coreutils.ts`:

- Short options can be combined (`-la`); an option that takes a value accepts it attached (`-n5`) or as
  the next argument (`-n 5`).
- Options are recognised anywhere on the command line, also after operands (as GNU programs do); `--`
  ends them. Programs that run another command (`xargs`, `env`, `timeout`, `nice`, `nohup`, `time`)
  stop at their first operand, so the command's own options reach it (`xargs stat -c %F`).
- Digits are option letters like any other (`ls -1`, `xargs -0`).
- Unknown options are accepted silently and ignored.
- Long options are mapped where listed; `--name=value` sets a value.
- File operands that can't be read print `<cmd>: <file>: <reason>` and the command continues with the next
  one; the exit status is then 1 (2 for `ls`, `grep`, `diff`).
- A command that a wrapper (`env`, `xargs`, `timeout`, `nice`, `nohup`, `time`) can't start gives 127
  if it doesn't exist, else 126.
- `-` as a file operand means stdin where a command reads files.

### Command table

| Command | Options | Notes / differences from GNU |
|---|---|---|
| `base64` | `-d`, `-w…` | Encodes with 76-column lines; any `-w` disables wrapping (its value is not read). Only the last file operand is used. `-d` ignores whitespace. |
| `basename` | `-a`, `-s SUF` | `basename NAME [SUFFIX]`; with `-a`/`-s`, every operand. |
| `cat` | `-n` | Other options ignored. Stdin is streamed. |
| `chmod` | `-R` | See [chmod](#chmod). |
| `chown` | — | Does nothing, status 0. |
| `clear` | — | Writes `ESC[H ESC[2J ESC[3J`. |
| `cp` | `-r` `-R` `-a` `-n` `-P` `-d` `-f`, `--recursive`, `--force` | See [cp, mv, rm, ln](#cp-mv-rm-ln). |
| `cut` | `-d C`, `-f LIST`, `-c LIST`, `-b LIST` | See [cut](#cut). |
| `date` | `-u`, `-d STR`, `-r FILE`, `-I[FMT]`, `-R`, `+FORMAT` | See [date](#date). |
| `df` | — | Prints a fixed line: `vfs 4194304 0 4194304 0% /`. |
| `diff` | `-u`, `-U N`, `-q`, `-s`, `-i`, `-w`, `-b`, `-L`, `-a` | See [diff](#diff). |
| `dirname` | — | One line per operand. |
| `du` | `-s`, `-h`, `-a`, `-d N`, `--max-depth=N` | See [du](#du). |
| `echo` | `-n -e -E` | Same as the built-in. |
| `egrep`, `fgrep` | as `grep` | `grep -E` / `grep -F`. |
| `env` | `-i`, `-`, `-u NAME`, `-C DIR`, `-S STRING` | See [env](#env). Also `/usr/bin/env`. |
| `false` | — | Status 1. |
| `file` | `-b`, `-L` | See [file](#file). |
| `find` | see [find](#find) | |
| `free` | — | Prints fixed values (total 4194304, used 0). |
| `grep` | see [grep](#grep) | |
| `head` | `-n N`, `-N`, `-c N` | See [head and tail](#head-and-tail). |
| `hostname` | — | `openvessel`. Cannot be changed. |
| `id` | `-u`, `-g`, `-un`, `-nu` | `uid=1000(user) gid=1000(user) groups=1000(user)`; `-u`/`-g` print `1000`, `-un` prints `user`. |
| `kill` | `-s SIG`, `-n N`, `-SIG`, `-N`, `-l`, `-L` | See [ps and kill](#ps-and-kill). |
| `less`, `more` | as `cat` | No paging: they behave exactly like `cat`. |
| `ln` | `-s`, `-f`, `-n` | See [cp, mv, rm, ln](#cp-mv-rm-ln). |
| `ls` | see [ls](#ls) | |
| `md5sum`, `sha1sum`, `sha256sum`, `sha512sum` | — | See [Checksums](#checksums). |
| `mkdir` | `-p`, `--parents`, `-m MODE` | `-m` sets an octal mode; without it new directories get `0755`. Missing operand: status 1. |
| `mkfifo` | `-m MODE` | Default mode `0666 & ~umask`. |
| `mktemp` | `-d`, `-t`, `-p DIR` | See [mktemp](#mktemp). |
| `mv` | `-n` | See [cp, mv, rm, ln](#cp-mv-rm-ln). |
| `nice` | `-n N`, `-N` | Runs the command; the niceness is ignored. Without a command prints `0`. |
| `nl` | — | Numbers non-empty lines (`%6d<TAB>`); empty lines are printed empty. Operands are files. |
| `nohup` | — | Runs the command as is (no `nohup.out`, no signal changes). No command: status 125. |
| `nproc` | — | `navigator.hardwareConcurrency`, or 4. |
| `printf` | `-v VAR` | Same as the built-in. |
| `ps` | — | See [ps and kill](#ps-and-kill). |
| `pwd` | — | Prints the process cwd. |
| `readlink` | `-f`, `-e`, `-m` | Without options: the link target, or status 1 without a message if the path is not a symbolic link. With any of the options: the canonical path, or status 1 without a message if it does not exist. |
| `realpath` | `-m` | Canonical path; `-m` prints the lexically resolved path when it does not exist. |
| `rev` | — | Reverses each line (by code point). |
| `rm` | `-r` `-R` `--recursive` `-f` `--force` `-d` `-v` | See [cp, mv, rm, ln](#cp-mv-rm-ln). |
| `rmdir` | `-p` | `-p` also removes the parent directories named in the operand. |
| `sed` | see [sed](#sed) | |
| `seq` | see [seq](#seq) | |
| `sleep` | — | See [sleep](#sleep). |
| `sort` | see [sort](#sort) | |
| `stat` | `-L`, `-f`, `-c FMT`, `--printf FMT`, `-t` | See [stat](#stat). |
| `stty` | `size`, `raw`, `-raw`, `sane`, `cooked`, `echo`, `-echo` | Needs a TTY on stdin (status 1 otherwise). `size` prints `rows cols`. Other settings are ignored. |
| `sync` | — | Does nothing, status 0. |
| `tail` | `-n N`, `-n +N`, `-N`, `-c N`, `-c +N`, `-q`, `-f` | See [head and tail](#head-and-tail). |
| `tee` | `-a` | Copies stdin to stdout and each file (truncated, or appended with `-a`). |
| `test`, `[` | — | Same as the built-ins. |
| `time` | — | See [time and timeout](#time-and-timeout). |
| `timeout` | `-s SIG`, `-k DUR`, `--preserve-status`, `-v` | See [time and timeout](#time-and-timeout). |
| `touch` | `-c`; `-d X`, `-t X`, `-r X` accepted | Creates missing files; sets atime and mtime of existing ones to now. The `-d`/`-t`/`-r` values are ignored (always now). `-c`: don't create. |
| `tr` | `-d`, `-s`, `-c`, `-t` | See [tr](#tr). |
| `true` | — | Status 0. |
| `truncate` | `-s N` | Sets each file to `N` bytes (default 0), creating it if missing. Only a plain byte count is accepted (no `K`/`M` suffix, no `+`/`-`). |
| `tty` | `-s` | `/dev/tty` if stdin is a TTY (the path the kernel gives a terminal), else `not a tty` and status 1. `-s`: status only. There is no device node for it in the file system (`stat /dev/tty` fails). |
| `uname` | `-a -s -n -r -v -m -p -o` | `Linux`, `openvessel`, `6.1.0-openvessel`, `#1 SMP`, `x86_64` (`-m` and `-p`), `GNU/Linux`. No option: `-s`. `-a` prints them in the order s n r v m o. |
| `uniq` | `-c`, `-d`, `-u`, `-i` | See [uniq](#uniq). |
| `wc` | `-l`, `-w`, `-c`, `-m` | See [wc](#wc). |
| `which` | `-a` | Prints the path found on `PATH`; `-a` prints every executable match. Status 1 if any name is not found. |
| `whoami` | — | `user`. |
| `xargs` | `-n N`, `-L N`, `-I STR`, `-i`, `-0`, `-d DELIM`, `-a FILE`, `-r`, `-t`, `-P N` | See [xargs](#xargs). |
| `yes` | — | Repeats its arguments joined by spaces (default `y`) until killed or the pipe closes. |
| `curl`, `wget` | see [curl and wget](#curl-and-wget) | In `/usr/bin`. |
| `node`, `nodejs` | — | In `/usr/bin`. See [Node.js runtime](nodejs-runtime.md). |
| `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `bun`, `bunx`, `corepack` | — | In `/usr/bin`. See [Package managers](package-managers.md). |

There is no `awk`, `od`, `xxd`, `tar`, `gzip`, `unzip`, `git`, `python`, `make` or editor; running them
gives `command not found` (status 127).

### ls

```text
ls [-a] [-A] [-l] [-h] [-R] [-t] [-r] [-d] [-1] [--no-color] [file...]
```

| Option | Long form | Effect |
|---|---|---|
| `-a` | `--all` | include names starting with `.`, plus `.` and `..` |
| `-A` | `--almost-all` | include names starting with `.`, without `.` and `..` |
| `-l` | `--long` | long format |
| `-h` | `--human` | sizes in `K`, `M`, `G`, `T` (powers of 1024; one decimal below 10) in long format |
| `-R` | `--recursive` | list subdirectories recursively |
| `-t` | | sort by modification time, newest first |
| `-r` | | reverse the order |
| `-d` | | list directories themselves, not their contents |
| `-1` | | one name per line |
| | `--no-color` | no colours |

- Names are sorted with `localeCompare`. Without a TTY on stdout the output is one name per line;
  on a TTY it is in columns (filled top to bottom) fitted to the terminal width, and coloured: directories
  bold blue, symbolic links bold cyan, executables bold green.
- Long format: `mode links user user size date name`, with `-> target` for links. The owner and group
  are always `user`; setuid, setgid and sticky bits show as `s`/`S`/`t`/`T`. The date is `Mon dd HH:MM`
  within 180 days of now, else `Mon dd  YYYY`. A `total` line (sum of sizes in KiB, rounded up per file)
  precedes the contents of each directory; file operands get none.
- An operand that does not exist: `ls: cannot access 'x': No such file or directory`, status 2.

### cat

`cat [-n] [file...]` concatenates files to stdout; no operand or `-` streams stdin chunk by chunk (a
reader at the other end of a pipe sees data as it arrives). `-n` numbers every line (`%6d<TAB>`).

### head and tail

```text
head [-n N | -N | -n -N] [-c N] [file...]
tail [-n N | -N | -n +N] [-c N] [-f] [file...]
```

- `head`: first `N` lines (default 10) or `N` bytes. `-n -N` prints all but the last `N` lines. When
  reading stdin with a non-negative count, `head` stops reading as soon as it has its lines, so
  `yes | head -1` terminates. With several files each is preceded by `==> name <==`.
- `tail`: last `N` lines (default 10), or from line `N` with `+N`; the last `N` bytes with `-c N`, from
  byte `N` on with `-c +N`. `tail` reads the whole input first. With several files each is preceded by
  `==> name <==` (not with `-q`). A last line without a newline is printed without one.
- `tail -f file` (one file only): after printing, polls the file every 250 ms and prints appended data
  until killed; if the file shrinks it continues from the new end.

### wc

`wc [-l] [-w] [-c] [-m] [file...]`. Without options, lines, words and bytes. `-m` counts characters
(code points) in the third column instead of bytes. Words are runs of non-whitespace. Columns are
right-aligned to the widest number; reading only stdin prints the numbers without padding. A `total` line
is added for more than one input.

### grep

```text
grep [options] pattern [file...]
grep [options] -e pattern... [-f file]... [file...]
egrep ...    fgrep ...
```

| Option | Long form | Effect |
|---|---|---|
| `-i`, `-y` | `--ignore-case` | case-insensitive |
| `-v` | `--invert-match` | select non-matching lines |
| `-n` | `--line-number` | prefix line numbers |
| `-c` | `--count` | print the count of selected lines per file |
| `-l` / `-L` | `--files-with-matches` / `--files-without-match` | print only names of files with / without a match |
| `-q` | `--quiet`, `--silent` | no output; status only |
| `-s` | `--no-messages` | accepted |
| `-w` | `--word-regexp` | match whole words (not preceded or followed by a word character) |
| `-x` | `--line-regexp` | match whole lines |
| `-o` | `--only-matching` | print each non-empty match on its own line |
| `-G` / `-E` / `-F` / `-P` | `--basic-regexp` / `--extended-regexp` / `--fixed-strings` / `--perl-regexp` | pattern syntax (`-P`: JavaScript `RegExp` syntax) |
| `-r` / `-R` | `--recursive` / `--dereference-recursive` | search directories recursively (default `.`); `-r` skips symbolic links met on the way, `-R` follows them |
| `-h` / `-H` | `--no-filename` / `--with-filename` | never / always print file names |
| `-a` | `--text` | treat binary files as text |
| `-e PAT` | `--regexp=PAT` | a pattern; may be repeated |
| `-f FILE` | `--file=FILE` | patterns from a file, one per line (`-` for stdin) |
| `-m N` | `--max-count=N` | stop after `N` selected lines per file |
| `-A N`, `-B N`, `-C N` | `--after-context`, `--before-context`, `--context` | print `N` lines of context after / before / around each match |
| | `--include=GLOB`, `--exclude=GLOB`, `--exclude-dir=GLOB` | with `-r`, filter files and directories by base name (repeatable) |
| | `--color…` | accepted and ignored |

- A line is selected if any pattern matches. A pattern operand may hold several patterns separated by
  newlines.
- POSIX regular expressions are translated to JavaScript `RegExp`. In basic syntax (default) `\(` `\)`
  `\{` `\}` `\|` `\+` `\?` are the operators and the bare characters are literal, and a leading `*` is
  literal; `-E` uses extended syntax. Bracket expressions with classes (`[[:digit:]]`, `[[:alpha:]]`…)
  and the GNU escapes `\w` `\W` `\s` `\S` `\b` `\B` `\<` `\>` work. An invalid pattern prints the
  `RegExp` error, status 2.
- File names are prefixed when there is more than one file or with `-r`. Names under `.` are printed
  without `./` when no file operand was given.
- Context lines are printed with `-` instead of `:` after the file name and line number; groups that
  are not adjacent are separated by `--`.
- A file containing a NUL byte prints `Binary file NAME matches` (unless `-a`).
- Exit status: 0 if any line was selected, 1 if none, 2 if a file could not be read (also when other
  lines were selected) — except that `-q` returns 0 as soon as there is a match.

### sed

```text
sed [-n] [-E|-r] [-i[SUFFIX]] [-e script]... [-f file] [script] [file...]
```

| Option | Effect |
|---|---|
| `-n`, `--quiet`, `--silent` | don't print the pattern space automatically |
| `-e script`, `--expression=script` | add a script (several are joined with newlines) |
| `-f file`, `--file=file` | read the script from a file |
| `-E`, `-r`, `--regexp-extended` | extended regular expressions |
| `-i[SUFFIX]`, `--in-place[=SUFFIX]` | edit the files in place; with a suffix, keep a backup `file+SUFFIX` (the suffix must be attached: `-i.bak`) |
| `-s`, `-u`, `-z` | accepted and ignored |

The first operand is the script if no `-e`/`-f` was given; the rest are files. Options may be combined
(`-ne`, `-Ei`) and given anywhere; an unknown option prints `sed: invalid option -- 'x'`, status 1.
Without `-i`, all inputs are concatenated and processed as one stream.

Addresses: a line number `N`, `$` (last line), `/regex/` (or `\cregexc` with another delimiter), each
optionally followed by `I` for case-insensitive regexes. `addr1,addr2` selects a range (if `addr2` is a
line number not greater than the current line, only one line). `!` after the address negates it.

| Command | Effect |
|---|---|
| `s/re/repl/flags` | substitute; any delimiter (escaped as `\/` inside the parts). Flags: `g` (all), `N` (only the N-th match, one digit), `p` (print if replaced), `i`/`I` (ignore case). In `repl`: `&` = the match, `\1`–`\9` = groups, `\&` = literal `&`, `\n` `\t` and the other escapes below, `\U` `\L` (upper / lower case until `\E`), `\u` `\l` (the next character). |
| `y/abc/xyz/` | transliterate |
| `d` | delete the line, start the next cycle |
| `p` | print the line |
| `=` | print the line number |
| `q` | print (unless `-n`) and quit |
| `a text`, `a\` + newline + `text` | append text after the line |
| `i text` | insert text before the line |
| `c text` | replace the line with text |

Commands are separated by `;` or newlines. Regular expressions use the same POSIX→JavaScript
translation as `grep`, plus GNU sed's escapes `\n` `\t` `\r` `\f` `\v` `\a`, `\dNNN`, `\oNNN`, `\xHH`
and `\cX`. Not supported: `{ }` blocks (the braces are ignored, so the commands inside apply to every
line), `n N P D h H g G x b t T r w l`, `0,/re/`, `addr,+N`, `first~step`. A final line without a newline is output without one.

```sh
sed -i 's/"dev": ".*"/"dev": "astro dev"/' package.json
sed -n '/^## /p' README.md
sed -E 's/([0-9]+)\.([0-9]+)/\2.\1/g' versions.txt
```

### find

```text
find [path...] [expression]
```

Paths are the leading arguments that don't start with `-` and aren't `!` or `(`; default `.`. Entries are
visited depth-first in sorted order; symbolic links are not followed. Results are printed as the path
given plus the relative name (`./src/a.js`).

| Expression | Meaning |
|---|---|
| `-name PAT`, `-iname PAT` | base name matches the shell pattern (case-insensitive) |
| `-path PAT`, `-wholename PAT` | the whole printed path matches (`*` also matches `/`) |
| `-type T` | `f` regular file, `d` directory, `l` symbolic link, `p` FIFO, `s` socket, `c` / `b` character / block device; a comma list (`f,d`) matches any |
| `-maxdepth N`, `-mindepth N` | global depth limits (wherever they appear) |
| `-empty` | empty regular file or directory |
| `-newer FILE` | modified after `FILE` |
| `-size [+-]N[ckMG]` | size in units of 512 bytes (default), `c` bytes, `k` KiB, `M` MiB, `G` GiB; `+` more, `-` less, else equal after rounding up |
| `-true`, `-false` | |
| `-print`, `-print0` | print the path followed by newline / NUL |
| `-prune` | don't descend into this directory |
| `-delete` | delete (directories recursively) |
| `-exec CMD {} ;`, `-exec CMD {} +` | run `CMD` with `{}` replaced by the path; with `+` (after a lone `{}`), one run with all the paths |
| `!`, `-not`, `( )`, `-a`, `-and`, `-o`, `-or` | operators; juxtaposition means `-a` |

- Without `-print`, `-print0`, `-delete` or `-exec`, every entry for which the expression is true is
  printed.
- `-delete` and `-exec` are deferred: they run after the whole walk (deletions deepest first), so
  `-exec` is always true as a predicate. With `;`, `{}` is replaced also inside a word (`"<{}>"`). The
  status is 1 if any `-exec` command fails.
- An unknown predicate prints `find: unknown predicate '-x'`, status 1. A starting path that does not
  exist prints `find: 'path': No such file or directory`, status 1.

### sort

```text
sort [-n] [-h] [-f] [-r] [-u] [-t SEP] [-k N] [-o FILE] [file...]
```

| Option | Effect |
|---|---|
| `-n`, `-h` | numeric, by `parseFloat` of the key (non-numbers count as 0; `-h` does not understand `K`/`M` suffixes) |
| `-f` | ignore case |
| `-r` | reverse |
| `-u` | drop adjacent duplicate lines (compares whole lines) |
| `-t SEP` | field separator (default: runs of whitespace, after trimming the line) |
| `-k N` | key from field `N` to the end of the line (`-k2,2` and modifiers like `-k2n` are read as `-k2`) |
| `-o FILE` | write to `FILE` |

Comparison is by UTF-16 code unit (no locale collation). The sort is stable. Other GNU options (`-V`,
`-c`, `-s`, `-z`, `-b`, `-M`) are ignored.

### uniq

`uniq [-c] [-d] [-u] [-i] [file]` collapses adjacent equal lines. `-c` prefixes the count (`%7d `), `-d`
prints only repeated lines, `-u` only unique lines, `-i` ignores case. Only the first operand is read; an
output-file operand is ignored.

### cut

`cut -f LIST [-d C] [file...]` selects fields (default delimiter TAB); `-c LIST` or `-b LIST` select
characters (both count characters, not bytes). `LIST` is comma-separated `N`, `N-M`, `N-`, `-M`. With `-f`,
lines without the delimiter are printed unchanged (there is no `-s`), and the output delimiter is the
input delimiter.

### tr

`tr [-c] [-d] [-s] [-t] SET1 [SET2]` reads stdin only. Sets support ranges (`a-z`), the classes
`[:lower:]` `[:upper:]` `[:digit:]` `[:space:]` `[:alpha:]` `[:alnum:]`, and `\n \t \r \\`.

- Translating: each character of `SET1` becomes the character at the same position of `SET2`; if `SET2`
  is shorter its last character is repeated (`-t` truncates `SET1` to the length of `SET2` instead).
- `-c` complements `SET1`: with a `SET2`, every character not in `SET1` becomes the last character of
  `SET2`, and the characters of `SET1` stay.
- `-d` deletes the characters of `SET1` (or of its complement with `-c`).
- `-s` squeezes runs of a repeated character into one: characters of `SET2` when translating or
  deleting, else of `SET1`.
- A missing operand prints `tr: missing operand`, status 1.

```sh
echo "Hello" | tr a-z A-Z        # HELLO
tr -d '\r' < dos.txt > unix.txt
tr -cs '[:alnum:]' '\n' < in.txt   # one word per line
```

### xargs

```text
xargs [-0] [-d DELIM] [-a FILE] [-n N | -L N | -I STR] [-r] [-t] [-P N] [command [arg...]]
```

- Options end at the command: everything after it reaches the command (`xargs stat -c %F`).
- Reads all of stdin (or `FILE` with `-a`) and splits it into items at blanks and newlines; single and
  double quotes and backslashes protect blanks (`'a b'` is one item; an unmatched quote is an error). With
  `-0` items are separated by NUL, with `-d` by the given character (`\n`, `\t` … are understood), both
  without quote processing.
- Runs `command` (default `echo`) with the items appended — all at once, or `N` at a time with `-n` / `-L`
  (`-L` counts items, not lines).
- `-I STR` (`-i` means `-I {}`): one run per input line (leading blanks removed), replacing every `STR` in
  the arguments.
- `-r`: don't run the command when there are no items (otherwise it runs once without items). `-t`
  prints each command line to stderr. `-P` is accepted; commands always run one after another.
- Status: 123 if any run exited 1–125; 124 (and stop) if one exited 255; 125 if one was killed by a
  signal; 127 / 126 if the command can't be found / run.

```sh
find . -name '*.log' -print0 | xargs -0r rm -f
```

### cp, mv, rm, ln

- `cp [-r|-R|-a] [-n] [-P|-d] SRC... DEST`: with several sources `DEST` must be a directory. A directory
  source without `-r`/`-R`/`-a` prints `cp: -r not specified; omitting directory 'x'`. `-n` skips
  existing targets. A symbolic link given as a source file is copied as the file it points to, unless
  `-a`, `-P` or `-d`; links inside copied directories stay links. `-a` means recursive without
  dereferencing; other `-a` semantics (ownership, timestamps) are not implemented by `cp` itself.
- `mv [-n] SRC... DEST`: renames; an existing non-directory target is replaced. `-f`, `-i`, `-v` are
  ignored.
- `rm [-r|-R] [-f] [-d] [-v] FILE...`: `-r` removes directories recursively, `-d` empty directories, `-f`
  ignores missing files and a missing operand, `-v` prints `removed 'x'`. As GNU rm with its default
  `--preserve-root`, `rm -r /` refuses (`it is dangerous to operate recursively on '/'`, status 1), and
  `.` and `..` (also `dir/.`) are refused. There are no prompts (`-i` is ignored).
- `ln [-s] [-f] [-n] TARGET [LINK]`: hard link by default, `-s` symbolic. Without `LINK`, the link is
  created in the cwd with the target's base name; if `LINK` is a directory (and no `-n`), inside it. `-f`
  removes an existing `LINK` first. Only the first two operands are used.

### chmod

`chmod [-R] [-c] [-f] [-v] MODE FILE...`. `MODE` is octal (`755`) or a comma-separated list of
`[ugoa]*[+-=][rwxXst]*` or `[ugoa]*[+-=][ugo]` (copy another class's bits: `g=u`).

- `+` and `-` add and remove bits for the named classes, `=` sets the named classes and leaves the
  others (`chmod u=rw f` on `755` gives `655`).
- Without a class letter, the bits apply to all classes except those masked by the umask (with umask
  `022`, `chmod +w f` only adds the owner's write bit; `a+w` adds all three).
- `X` sets execute only for directories or files that already have an execute bit; `s` and `t` set the
  setuid / setgid and sticky bits.
- A mode such as `-x` or `-w,+r` is a mode, not an option.
- `-R` recurses; symbolic links met while recursing are neither changed nor followed. `-c`, `-f`, `-v`
  are accepted.
- An invalid mode prints `chmod: invalid mode: 'x'`, status 1.

### stat

`stat [-L] [-c FORMAT | --printf FORMAT] [-t] FILE...` and `stat -f FILE...`. Without `-L` links are not
followed. The default output follows GNU's layout, with times in the local time zone (`TZ`):

```text
  File: f.txt
  Size: 18              Blocks: 1          IO Block: 4096   regular file
Device: 801h/2049d	Inode: 139         Links: 1
Access: (0644/-rw-r--r--)  Uid: ( 1000/    user)   Gid: ( 1000/    user)
Access: 2026-10-26 15:11:32.702000000 +0900
Modify: 2026-10-26 15:11:32.702000000 +0900
Change: 2026-10-26 15:11:32.702000000 +0900
 Birth: 2026-10-26 15:11:32.702000000 +0900
```

`-c FORMAT` sequences: `%n` name, `%N` quoted name (with `-> target` for links), `%s` size, `%b` blocks,
`%B` 512, `%o` I/O block, `%a` octal mode, `%A` mode string, `%f` raw mode (hex), `%F` file type
(`regular file`, `regular empty file`, `directory`, `symbolic link`, `fifo`, `socket`,
`character special file`, `block special file`), `%h` links, `%i` inode, `%d`/`%D` device (decimal /
hex), `%t`/`%T` device major / minor (hex), `%u`/`%g` uid / gid, `%U`/`%G` `user`, `%x %y %z %w`
access / modify / change / birth time, `%X %Y %Z %W` the same in seconds, `%%`; any other sequence prints
`?`. A newline is added; `--printf` adds none and understands `\n`, `\t`, `\\`. `-t` prints the terse
one-line form.

`-f` reports the file system instead: one in-memory file system, type `tmpfs`, block size 4096,
1048576 blocks all free. With `-c`: `%n %T %t %s %S %b %f %a %c %d %l %i`.

### du

`du [-s] [-h] [-a] [-d N|--max-depth=N] [path...]`. A directory counts 4096 bytes plus its contents;
files count their size. Values are KiB rounded up, or human-readable with `-h`. Directories are printed
after their contents; `-a` also prints files; `-s` only the operands. Errors are printed but the status
is always 0.

### date

```text
date [-u] [-d STRING | -r FILE] [-I[FMT] | -R | +FORMAT]
```

The time zone is `TZ` — an IANA name (`Asia/Tokyo`), a POSIX string (`JST-9`, `EST5`), `''` for UTC —
or, when `TZ` is unset, the browser's zone; `-u` uses UTC. Zone abbreviations are those `Intl` gives
(`EST`, `GMT`, `UTC`), a built-in table for common zones that `Intl` names only by offset (`JST`, `KST`,
`CET`/`CEST`, `AEST`…), else the offset in tzdata's style (`+0530`).

`-d @SECONDS` uses a Unix time; `now`, `today`, `tomorrow`, `yesterday` are understood; `YYYY-MM-DD` and
`YYYY-MM-DD HH:MM[:SS]` are local times in the zone; any other string is parsed by JavaScript `Date`. An
unparsable date prints `date: invalid date 'x'`, status 1. `-r FILE` uses the file's modification time.
Without a format the output is GNU's default, `%a %b %e %H:%M:%S %Z %Y` (`Mon Oct 26 16:12:57 JST 2026`).
`-I` prints ISO 8601 (`date`, `hours`, `minutes`, `seconds`, `ns`), `-R` RFC 5322.

| Sequence | Value |
|---|---|
| `%Y` `%y` `%C` `%G` `%g` | year, 2-digit year, century, ISO week year (4 / 2 digits) |
| `%m` `%d` `%e` `%j` | month, day, day padded with a space, day of the year |
| `%H` `%I` `%k` `%l` `%M` `%S` | hour (24 / 12, `%k` `%l` space-padded), minute, second |
| `%p` `%P` | `AM`/`PM`, `am`/`pm` |
| `%a` `%A` `%b` `%h` `%B` | day and month names (C locale) |
| `%u` `%w` `%U` `%W` `%V` | weekday (1–7 / 0–6), week of the year (Sunday / Monday first, ISO) |
| `%s` `%N` | Unix seconds, nanoseconds (millisecond precision; `%3N` gives 3 digits) |
| `%F` `%T` `%D` `%R` `%r` `%c` `%x` `%X` | `%Y-%m-%d`, `%H:%M:%S`, `%m/%d/%y`, `%H:%M`, `%I:%M:%S %p`, `%a %b %e %H:%M:%S %Y`, `%m/%d/%y`, `%H:%M:%S` |
| `%z` `%:z` `%::z` `%Z` | `+0900`, `+09:00`, `+09:00:00`, zone abbreviation |
| `%n` `%t` `%%` | newline, tab, `%` |

Flags after `%`: `-` (no padding), `_` (pad with spaces), `0` (pad with zeros), `^` (upper case), `#`
(swap case), and a width (`%10s`). Other sequences are printed unchanged. Setting the clock is not
supported.

### diff

```text
diff [-u | -U N] [-q] [-s] [-i] [-w] [-b] [-a] [-L LABEL]... FILE1 FILE2
```

Either file may be `-` for stdin. Equal files: no output, status 0 (`-s` prints
`Files A and B are identical`). Different: status 1; trouble (a missing file, a directory, wrong
operands): status 2.

- Default (normal format): change commands such as `2c2`, `4a5`, `1d0`, followed by the old lines
  prefixed `< `, `---`, and the new lines prefixed `> `.
- `-u` / `-U N`: unified format with `N` (default 3) lines of context. The header is
  `--- FILE1<TAB>mtime` / `+++ FILE2<TAB>mtime` (time as `2026-10-26 16:12:57.123000000 +0900`), or the
  `-L` labels; then `@@ -l,n +l,n @@` hunks; changes closer than 2N lines share a hunk.
- A last line without a newline is followed by `\ No newline at end of file`, and differs from the same
  line with one.
- `-q` prints only `Files A and B differ`. `-i` ignores case, `-w` all whitespace, `-b` changes in the
  amount of whitespace. A file with a NUL byte gives `Binary files A and B differ` unless `-a`.
- The edit script is minimal (Myers' algorithm); for very different large inputs it falls back to
  replacing the whole changed middle. Directories are not compared (`-r` is not supported).

### file

`file [-b] [-L] NAME...` prints `directory`, `symbolic link to TARGET` (followed with `-L`),
`fifo (named pipe)`, `socket`, `character special (M/m)`, `block special (M/m)`, `empty`, `data` (a NUL
byte in the first 4096 bytes), `X script, ASCII text executable` (a `#!` line), `Unicode text, UTF-8
text` or `ASCII text`. `-b` omits the name. Errors are printed to stdout as
``NAME: cannot open `NAME' (reason)``; the status is always 0.

### mktemp

`mktemp [-d] [-t] [-p DIR] [TEMPLATE]` creates a file (mode `0600`, exclusively) or with `-d` a directory
(mode `0700`) and prints its absolute path. The trailing `X`s of `TEMPLATE` (default `tmp.XXXXXXXXXX`) are
replaced with random `[a-z0-9]` characters. The directory is `DIR` with `-p`, else `$TMPDIR` (`/tmp`) with
`-t` or when no template is given, else the cwd.

### seq

```text
seq [-s SEP] [-w] [-f FORMAT] [FIRST [INCREMENT]] LAST
```

Numbers may be negative (`seq -2 2 2`) or fractional; each output number has as many decimals as `FIRST`
and `INCREMENT` (`seq 0 0.1 0.3` prints `0.0` … `0.3`), and is computed as `FIRST + k*INCREMENT` so no
error accumulates. `-s` sets the separator (attached or separate: `-s,`, `-s ,`); a newline ends the
output. `-w` pads with zeros to equal width. `-f` takes one `%f`, `%g` or `%e` conversion with flags,
width and precision (`%03g`). An invalid number or a zero increment prints an error, status 1.

### sleep

`sleep N[s|m|h|d]...` sleeps for the sum of the arguments (fractions allowed, default unit seconds; `inf`
sleeps until a signal). An invalid argument prints `sleep: invalid time interval 'x'`, status 1. A signal
ends the sleep.

### Checksums

`md5sum`, `sha1sum`, `sha256sum`, `sha512sum` print `HEX  NAME` per input (`-` for stdin). SHA digests use
Web Crypto; MD5 uses `@noble/hashes`. There is no check mode (`-c`); errors are printed before the results.

### ps and kill

`ps` takes no options and prints `PID PPID CMD` for every running process (kernel programs and Node.js
processes).

`kill [-s SIGNAL | -n NUMBER | -SIGNAL | -NUMBER] [--] PID...`: the default signal is SIGTERM; `-9`,
`-KILL`, `-SIGKILL`, `-s kill` are equivalent. Signal `0` sends nothing and only checks that the process
exists (status 0, or 1 with `No such process`). PID `0` is the caller's process group, `-1` every
process except `kill` itself, `-N` process group `N` (write `kill -TERM -123` or `kill -- -123`).
`kill -l` lists the signal names, `kill -L` a table with numbers, `kill -l 15` / `kill -l 143` (an exit
status) print `TERM`, `kill -l TERM` prints `15`. An unknown signal prints `kill: X: invalid signal
specification`, status 1; a process that doesn't exist (or has ended) `kill: (PID) - No such process`,
status 1. The signals themselves are described in [Processes](processes.md).

### env

```text
env [-i | -] [-u NAME]... [-C DIR] [-S STRING] [NAME=VALUE]... [command [arg...]]
```

Without a command, prints the resulting environment as `NAME=VALUE` lines. `-i`/`-` starts from an empty
environment (only the `NAME=VALUE` operands are kept). `-u` removes a variable (also `-uNAME`,
`--unset=NAME`). `-C DIR` runs the command in `DIR`. `-S STRING` splits the rest of the line at
whitespace (used by `#!/usr/bin/env -S`). A command that cannot be started prints
`env: 'cmd': No such file or directory`, status 127 (126 for another error).

### time and timeout

`time command [arg...]` runs a program (not a shell function or a compound command — it is a program,
not a keyword), then writes `real\tMmS.SSSs` preceded by an empty line to stderr. There are no `user` and
`sys` lines. Status: the command's.

```text
timeout [-s SIGNAL] [-k DURATION] [--preserve-status] [-v] DURATION command [arg...]
```

Runs the command and sends `SIGNAL` (default SIGTERM) after `DURATION` (a number with an optional
`s`, `m`, `h`, `d` suffix; `0` disables the timeout). Options end at `DURATION`: the command keeps its own
options (`timeout 5 sh -c '…'`). `-k` sends SIGKILL that long after the first signal if the command is
still running; `-v` reports the signals sent on stderr. Status: 124 if the time ran out (137 if the
command had to be killed with SIGKILL), with `--preserve-status` the command's own status instead;
otherwise the command's status; 125 for an invalid duration or signal; 127 / 126 if the command can't be
found / run.

### curl and wget

`curl` and `wget` are in `/usr/bin`. Requests go through the kernel's network gate and the runtime's
fetch proxy, so the [network policy](network-policy.md) applies and the target server must allow
cross-origin requests from the browser; a request the browser cannot make fails with status 7.

```text
curl [options] URL
```

| Option | Effect |
|---|---|
| `-X M`, `--request M` | HTTP method |
| `-H "K: V"`, `--header` | add a request header |
| `-d S`, `--data`, `--data-ascii`, `--data-binary`, `--data-raw` | request body; several are joined with `&`. `@file` reads a file (not with `--data-raw`); `-d` drops newlines, `--data-binary` keeps them. Changes `GET` to `POST` and sets `Content-Type: application/x-www-form-urlencoded` unless given. |
| `-G`, `--get` | send the `-d` data as the query string of a `GET` |
| `-A S`, `-e URL`, `-u USER:PW` | `User-Agent`, `Referer` (dropped by the browser), basic `Authorization` header |
| `-o FILE`, `--output` | write the output to `FILE` (`-` for stdout) |
| `-O`, `--remote-name` | write the output to the URL's base name (`index.html` if empty) |
| `-I`, `--head` | `HEAD` request; print the status line and headers only |
| `-i`, `--include` | print the status line and headers before the body |
| `-D FILE`, `--dump-header` | write the status line and headers to `FILE` (`-` for stdout) |
| `-w FMT`, `--write-out` | print `FMT` after the transfer: `%{http_code}`, `%{response_code}`, `%{url_effective}`, `%{content_type}`, `%{size_download}`, `%{method}`, `\n` |
| `-m S`, `--max-time` | give up after `S` seconds (status 28) |
| `-f`, `--fail` | status 22 and `curl: (22) The requested URL returned error: N` for HTTP status ≥ 400 |
| `-s`, `--silent` | no error messages (unless `-S`) |
| `-S`, `-L`, `--location`, `-k`, `--insecure`, `-v`, `--compressed` and other long options | accepted; no effect (there is no progress meter, redirects are always followed) |

- Short options combine, the one taking a value last (`-fsSLo out.tgz`, `-XPOST`). An unknown short
  option is an error (status 2).
- A URL without a scheme gets `http://`. Only one URL is used (the last non-option argument).
- `-i`/`-I`/`-D` print `HTTP/1.1 <code> <text>` and the origin server's response headers (as far as the
  browser exposes them), passed on by the proxy in its `x-ov-*` headers. The reason phrase is the
  server's, or the standard one for the code when the server sends none (as over HTTP/2).
- Request headers that browsers don't allow scripts to set (`Cookie`, `Origin`, `Referer`, `Host`,
  `Accept-Encoding`, `Sec-*`, `Proxy-*`, …) are dropped by the proxy. Cookies are never sent.
- No URL: `curl: no URL specified!`, status 2. A network error or a denied request: `curl: (7) <message>`,
  status 7.

`wget [-O FILE] URL` downloads to `FILE` (or stdout with `-O -`), by default to the URL's base name or
`index.html`. It runs `curl -fsSL`, so HTTP errors give status 22. Other options are ignored; note that the first
argument not starting with `-` (other than the value of `-O`) is taken as the URL.
