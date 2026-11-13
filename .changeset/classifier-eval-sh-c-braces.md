---
'@newrelic/preflight': patch
---

The Bash classifier now flags a destructive command that bash builds at runtime: the argument of `eval`, the `-c` script of `bash`, `sh`, `zsh` or `dash` (also behind `command` or `builtin`), and a brace group in command position such as `{rm,-rf,x}`. Shells nested more than three levels deep are flagged when their raw text matches a destructive pattern. Quoted text such as `echo "eval is fine"`, a brace group used as an argument such as `echo {a,b}`, and a harmless `bash -c 'echo hi'` stay unflagged. On 6,000 generated commands checked against real bash (seeds 1190 and 9002), the classifier missed 2,958 runs of the marker `rm` on main, 3,060 on #1179, and none now.
