#!/usr/bin/env bash
set -e
test -f note.txt
grep -q "^ready$" note.txt
echo "the note is right"
