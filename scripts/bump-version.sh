#!/bin/sh
# Bump the cache-busting ?v= number on every module import and on the stylesheet.
# Run it before each release: GitHub Pages caches files for a few minutes, and a visitor who already has an old
# module must not get it mixed with a new one.
cd "$(dirname "$0")/.." || exit 1
v=$(grep -o 'ui\.js?v=[0-9]*' index.html | grep -o '[0-9]*$')
[ -n "$v" ] || { echo "version marker not found in index.html" >&2; exit 1; }
n=$((v + 1))
sed -i "s/\.js?v=$v\b/.js?v=$n/g; s/\.css?v=$v\b/.css?v=$n/g" index.html src/*.js
echo "version $v -> $n"
