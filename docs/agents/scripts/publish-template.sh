set -e
cd /c/Users/bishi/Documents/Codex/Branch-build
S="docs/agents/briefs"
L="C:/Users/bishi/AppData/Local/Temp/claude-session-files"
echo "--- merge PR 101"
gh pr merge 101 --merge --subject "feat: document readers, memory layers, coder toolbox, browser pass 2, more chat services, benchmarks, hardening (0.15.0) (#101)" 2>&1 | tail -2
git fetch -q origin
SHA=$(git rev-parse origin/main); echo "main $SHA"
grep -q '"version": "0.15.0"' <(git show origin/main:package.json)
echo "--- release"
gh release create v0.15.0 --target "$SHA" --title "Branch Agent 0.15.0" --notes-file "$S/release-notes-0.15.0.md" "release/Branch-Agent-windows-x64.zip" "release/Branch-Agent-windows-x64.zip.sha256" 2>&1 | tail -1
gh release view v0.15.0 --json assets -q '.assets[].name'
echo "--- rehearsal 0.11.0 -> 0.15.0 (staged copy)"
cp "$S/rehearse-update.mjs" ./rehearse.tmp.mjs
node rehearse.tmp.mjs 2>&1 | grep -aE "^before:|^status:|window gone|old process alive|console windows|^after:|rehearsal app processes|rror"
rm -f rehearse.tmp.mjs
echo "publish exit=0"
