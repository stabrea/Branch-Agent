# Redesign phase 2 — shell: status

Branch `mac7/p2-shell`, worktree `C:/Users/bishi/Code/wt/p2-shell`, cut from trunk `mac/cross-platform` at 7c456c73.
Brief: `claude-session-files/branch/briefs/phase2/BRIEFS.md` › "shell" (Trunks rail, studio, people, 3D stand-ins).
Sample: `claude-session-files/branch/branch-grown-up/` (parts p6, p8, p9, p13, p21, p30, p36).
Screenshots: `claude-session-files/branch/phase2-shots/shell/`. Not merged into trunk (an integrator does that).

## Pieces

- [ ] 1. The rail (#9, #7): this computer, paired computers/phones and pinned Trunks, each with its own face
- [ ] 2. A Trunk's look saved on the Trunk (colour, face kind, shape, movement); edit after it is made; Branch's own right-click menu (#8)
- [ ] 3. Add a Trunk studio with one tab strip (A new Trunk / Another computer / Your phone) and Back; pairing a computer without a terminal command; rename computers; plain words after pairing (#34, #27)
- [ ] 4. People page with faces; Overview page that is not empty; "Who is using Branch" menu (#11, #23)
- [ ] 5. Replies show the assistant's own look; status dots that do not look broken (#18)
- [ ] 6. Procedural 3D stand-ins for Trunk faces with a smooth pairing ring, ships off (#46)
- [ ] 7. Guide button is a lightbulb (#36)
- [ ] Docs (docs/configuration.md), locales (en + fr), tests, screenshots, merge latest trunk

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 <explicit files>`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs.
- Screenshot script: `claude-session-files/branch/p2shell/shots.mjs <worktree> <scene...>` (scenes in scenes.mjs there).
