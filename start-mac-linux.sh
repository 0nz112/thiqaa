#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "ثبّت Node.js أولاً من https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
node src/index.js
