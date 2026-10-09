#!/usr/bin/env bash
# Download pinned frontend libraries into static/vendor (run once; no build step).
set -euo pipefail
cd "$(dirname "$0")/../static/vendor"
J=https://cdn.jsdelivr.net/npm
get() { mkdir -p "$(dirname "$2")"; curl -fsSL "$1" -o "$2"; echo "ok  $2"; }

get $J/@xterm/xterm@5.5.0/lib/xterm.js                 xterm/xterm.js
get $J/@xterm/xterm@5.5.0/css/xterm.css                xterm/xterm.css
get $J/@xterm/addon-fit@0.10.0/lib/addon-fit.js        xterm/addon-fit.js
get $J/@highlightjs/cdn-assets@11.10.0/highlight.min.js            hljs/highlight.min.js
get $J/@highlightjs/cdn-assets@11.10.0/styles/github.min.css        hljs/github.min.css
get $J/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css   hljs/github-dark.min.css
get $J/marked@14.1.2/marked.min.js                     marked/marked.min.js
get $J/dompurify@3.1.7/dist/purify.min.js              dompurify/purify.min.js
CM=$J/codemirror@5.65.18
get $CM/lib/codemirror.js                              codemirror/codemirror.js
get $CM/lib/codemirror.css                             codemirror/codemirror.css
get $CM/theme/material-darker.css                      codemirror/material-darker.css
for a in search/searchcursor search/search dialog/dialog edit/matchbrackets edit/closebrackets \
         selection/active-line mode/overlay mode/simple mode/loadmode mode/multiplex; do
  get $CM/addon/$a.js codemirror/addon/$a.js
done
get $CM/addon/dialog/dialog.css codemirror/addon/dialog/dialog.css
for m in python javascript css xml htmlmixed markdown gfm yaml shell sql clike go rust toml \
         dockerfile properties diff lua r julia perl ruby nginx cmake commonlisp; do
  get $CM/mode/$m/$m.js codemirror/mode/$m/$m.js
done
get $J/d3@7.9.0/dist/d3.min.js                         d3/d3.min.js
