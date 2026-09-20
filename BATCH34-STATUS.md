# Batch 3&4 Sample Parity Programme - Status Log

## Task
Close batches 3 and 4 of the sample-parity programme (29 total gaps):
- **Batch 3: Settings page furniture (19 gaps)** - DG-001–DG-003, DG-006, DG-008–DG-013, DG-063–DG-064, DG-071–DG-076, DG-078
- **Batch 4: The words (10 gaps)** - DG-019, DG-023, DG-032, DG-050, DG-077, DG-137, DG-150, DG-152–DG-153, DG-155

## Completed: 4 of 29 Gaps (✅ DONE, exact match verified or CSS-only)
- ✅ **DG-019**: Field labels CSS: `font-family: var(--font-mono)` → `font-family: var(--body)` (public/style.css:169)
- ✅ **DG-137**: Same CSS change applies (shared `<label>` rule)
- ✅ **DG-150**: Mode order reordered and renamed
  - ORDER: `["ask", "plan", "auto", "full"]` → `["auto", "ask", "plan", "full"]`
  - "mode.plan": "Plan" → "Plan first" (en.json + fr.json)
  - "mode.full": "Full access" → "No approvals" (with fullWarning, fullYes updated)
- ✅ **DG-152**: Number key chips added (ask→1, plan→3, full→4, display-only)
- ✅ **DG-153**: Footer text with mode explanation added to menu

## Untouched: 6 of Batch 4 (⏸️ NEED EXACT SAMPLE TEXT)
- ⏸️ **DG-023**: Jargon removal (strings must be extracted character-by-character from sample)
- ⏸️ **DG-032**: "Who your assistant is" duplication removal (need sample to determine structure)
- ⏸️ **DG-050**: Permissions section names (sample strings not yet extracted)
- ⏸️ **DG-077**: Achievement wording "Visited Models" (need to verify page id in data)
- ⏸️ **DG-155**: Terminal key hints wording (sample strings not yet extracted)

## Untouched: 19 of Batch 3 (⏸️ STRUCTURAL, NEED SAMPLE SCREENSHOTS)
- ⏸️ **DG-001** through **DG-078** (all 19 batch 3 gaps): Not started
- Includes back links, titles, versions, heading levels, layout changes, spacing fixes, new components
- Requires: Sample verification, before/after screenshots (1440×950 light), possible redraw tests for DG-006/013

## ⚠️ CRITICAL NOTES FOR NEXT AGENT (Do Not Skip)

### Quality Rule (Coordinator, 2026-09-20)
**For copy/wording rows: EXACT character-by-character match required, NOT approximate.**
- Extract strings from running sample at http://127.0.0.1:8777/index.html
- Include glyphs exactly: "☾ Moonlight", "☀ Daylight", separators "·" not "-" or "|"
- Capitalization matters: "Off · When needed · On" not "off · when needed · on"
- If unsure of exact text, copy directly from sample HTML/CSS, do NOT retype
- Better: fewer exact rows than all rows approximate
- Stop on a whole row if running low on tokens; list untouched rows by number

### Label-vs-Value Trap (Advisor, 2026-09-20)
**DG-150 and other mode/setting renamings: verify stored value vs display label**

Pattern proven: `[stored_value, locale_key, display_text_fallback]`
- **Stored values** (database, do NOT touch): "off", "when-needed", "on", "ask-before-changes", "workspace", etc.
- **Display labels** (locale files + inline fallbacks, OK to change): "Only when it is needed" → "When needed"
- Files with inline fallbacks to update (19 total): add-ons.js, asks.js, autonomy.js, coding.js, commands.js, context-files.js, dashboard/card.js, devices.js, flows-boards.js, interop.js, learning-loop.js, learning-more.js, people-admin.js, personal.js, prompt-library.js, reach.js, etc.

**For Batch 4 remaining work:**
- DG-150 mode rename already applied: verify stored modes stay "ask", "plan", "auto", "full" while labels show "Ask first", "Plan first", "Auto", "No approvals"
- DG-023 jargon: environment variable names and unit suffixes must survive ("BRANCH_MODEL_PRESETS", "(seconds)", "(hours)")

### 3-Second Redraw Bug (affects DG-006 and DG-013 in Batch 3)
**The window rebuilds every 3 seconds and can destroy state if not preserved.**
- DG-006 (jump links): Scroll position and active anchor must survive redraw
- DG-013 (390px tab strip): Horizontal scroll offset of strip must survive redraw
- Test pattern for both: action → wait >3000ms → assert state survived
- Example: click jump link to section → await 3500ms → verify still on same section
- Other batch 3 rows do NOT hold state and don't need redraw tests

### Batch Work Order (from Advisor)
1. **7-row wording sweep FIRST** (DG-019, DG-023, DG-032, DG-050, DG-077, DG-137, DG-155) — commit, push
2. **Mode picker rework** (DG-150, DG-152, DG-153) — one coherent rework of conversation-mode.js + locales, don't split
3. **Batch 3 structural** (all other rows) — CSS and new components, no redraw issues except DG-006/013

### Known Semantic Collision (DG-150)
Renaming `mode.full` from "Full access" → "No approvals" creates potential ambiguity:
- `mode.full` = conversation mode (what this conversation can do)
- `policy.preset.off` = owner's approval policy (what owner pre-approves)
- Both may render on same screen; warning text must travel with the rename
- Related: `mode.fullWarning` and `mode.fullYes` must also be updated/relabeled
- Flag in final report as potential register interpretation error

### Semantic Collision: DG-150 "No approvals" Name Reuse
**Warning (documented, not blocking):**
- `mode.full` (conversation mode) now reads "No approvals" — means this conversation can do anything without asking
- `policy.preset.off` (owner approval policy) also reads "No approvals" — means owner pre-approves everything globally
- **Problem:** Two different concepts, same label, may render on same screen
- **Status:** Rename applied per sample; collision documented here for owner awareness
- **Action:** Next agent should flag this in final report but do NOT change the labels (sample is authoritative)

### DG-152 Number Keys (display only, no handlers)
Sample shows: `1` `3` `4` chips. Map to positions in display order (not contiguous for good reason in sample).
Do NOT wire new key handlers — this is display-only. Confirm `Shift+Tab` cycling already exists before promising it in DG-153 footer.

## Sample Location
http://127.0.0.1:8777/index.html (served from C:/Users/bishi/Code/branch-sample/)

## Commits & Push Status
- ✅ Commit 1: docs: add batch 3&4 status with critical advisory notes
- ✅ Commit 2: style(batch34-DG019-DG137): change field labels from monospace to body font
- ✅ Commit 3: feat(batch34-DG150-DG152-DG153): reorder modes, rename, add number keys and footer
- ✅ Commit 4: docs: update batch 34 status - 4 of 10 batch 4 gaps complete
- ✅ Push to origin/mac7/batch34-settings (ready for PR or further work)
- ⏸️ Next: Update this status file before pushing final version

## Work Summary (4/29 Complete, 25 Waiting)
| Batch | Total | Done | Exact Match | Untouched |
|-------|-------|------|------------|-----------|
| **Batch 4: Words** | 10 | 4 | ✅ 4 | ⏸️ 6 (DG-023, 032, 050, 077, 155) |
| **Batch 3: Furniture** | 19 | 0 | — | ⏸️ 19 (DG-001–003, 006, 008–013, 063–064, 071–078) |
| **TOTAL** | **29** | **4** | **✅ 4** | **⏸️ 25** |
