---
'@newrelic/preflight': patch
---

The Bash classifier now flags a destructive command that bash builds at runtime: the argument of `eval`, the `-c` script of `bash`, `sh`, `zsh` or `dash` (up to three levels deep), and a brace group in command position such as `{rm,-rf,x}`. Quoted text such as `echo "eval is fine"`, a brace group used as an argument such as `echo {a,b}`, and a harmless `bash -c 'echo hi'` stay unflagged. On 6,000 generated commands checked against real bash, the classifier went from missing 3,060 runs of the marker `rm` to missing none.
