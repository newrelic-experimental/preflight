---
'@newrelic/preflight': patch
---

The Bash classifier now flags a destructive command that bash builds at runtime: the argument of `eval`, the `-c` script of `bash`, `sh`, `zsh` or `dash` in command position (also behind `command`, `builtin`, a reserved word such as `then` or `do`, or a `NAME=value` assignment, but not `sudo`, `env` or `xargs`), and a brace group in command position such as `{rm,-rf,x}`. Shells nested more than three levels deep are flagged when their raw text matches a destructive pattern. Quoted text such as `echo "eval is fine"`, a brace group used as an argument such as `echo {a,b}`, and a harmless `bash -c 'echo hi'` stay unflagged. Known misses: `eval` inside backticks, `bash` flags before `-c` such as `--norc`, `--login` or `-O extglob`, and quoted brace items such as `{rm,'-rf',x}`.
