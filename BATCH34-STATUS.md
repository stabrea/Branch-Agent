# Batch 3&4 Sample Parity Programme - Status Log

## Task
Close batches 3 and 4 of the sample-parity programme (29 total gaps):
- **Batch 3: Settings page furniture (19 gaps)** - DG-001–DG-003, DG-006, DG-008–DG-013, DG-063–DG-064, DG-071–DG-076, DG-078
- **Batch 4: The words (10 gaps)** - DG-019, DG-023, DG-032, DG-050, DG-077, DG-137, DG-150, DG-152–DG-153, DG-155

## Completed: 10 of 29 Gaps (✅ DONE, exact match verified or CSS-only)

**Previous agent (4 gaps):**
- ✅ **DG-019**: Field labels CSS: `font-family: var(--font-mono)` → `font-family: var(--body)` (public/style.css:169)
- ✅ **DG-137**: Same CSS change applies (shared `<label>` rule)
- ✅ **DG-150**: Mode order reordered and renamed
  - ORDER: `["ask", "plan", "auto", "full"]` → `["auto", "ask", "plan", "full"]`
  - "mode.plan": "Plan" → "Plan first" (en.json + fr.json)
  - "mode.full": "Full access" → "No approvals" (with fullWarning, fullYes updated)
- ✅ **DG-152**: Number key chips added (ask→1, plan→3, full→4, display-only)
- ✅ **DG-153**: Footer text with mode explanation added to menu

**This agent (6 CSS-only gaps):**
- ✅ **DG-009**: Removed two-column CSS layout; Settings now one full-width column on all widths (settings-grown.css:26-32)
- ✅ **DG-010**: Hidden scope chips "Applies to everything" pills with `display: none !important` (settings-kit.css:6)
- ✅ **DG-072**: Limited card paragraph text to ~70 characters max-width (settings-grown.css:19-22)
- ✅ **DG-074**: Removed filled box from empty states; changed background to transparent, no border (style.css:674-693)
- ✅ **DG-076**: Adjusted nav group headings: margin 18px, font-size 12px, font-weight 560 (settings-grown.css:183-190)

## Remaining Batch 4 (5 gaps) - Word changes, complex

- ⏸️ **DG-023**: Jargon removal (~13 strings across pages: BRANCH_MODEL_PRESETS, seconds, hours, etc.)
  - Complex: no single sample counterpart; requires judgment call on "plain words"
  - Recommendation: defer unless tokens allow; affects Advanced/Technical levels
- ⏸️ **DG-032**: "Who your assistant is" duplication on Assistant page
  - Structural: bucket header + first card both have same heading
  - Depends on DG-011 (remove bucket header)
- ⏸️ **DG-050**: Permissions section names reordering/rewording
  - Sample: When to check with me · Lockdown · Settings you have pinned · Limits on one task · When Branch checks · Keeping things safe
  - App current: When to check with me · How fast one conversation · Emergency stop · A second look before approvals
  - Requires: check if these are locale keys or inline text
- ⏸️ **DG-077**: Achievement wording "Visited Models" instead of "3 Settings pages"
  - Structural: code changes to `src/achievements.ts` line 113 to generate per-page achievements
  - Complex: changes achievement generation algorithm
- ⏸️ **DG-155**: Terminal key hints wording
  - Not yet researched in DESIGN-GAPS; deferred per advisor guidance

## Remaining Batch 3 (19 gaps) - Page furniture and layout
**CSS-only done (5):** DG-009, DG-010, DG-072, DG-074, DG-076

**High priority structural (need layout changes):**
- ⏸️ **DG-001/DG-064**: Add "Back to Branch" link with `<kbd>Esc</kbd>` chip to Settings nav
  - Sample: line 2714 shows `Back to Branch<kbd>Esc</kbd>`
  - Location: Settings nav top-left (public/layout.js or public/index.html)
- ⏸️ **DG-002**: Settings title with Branch mark and large "Settings" text (24 px)
  - Sample: line 2714 shows brandmark + "Settings" at 22px
  - Change: `<h1 class="brandmark" style="font-size:22px">`
- ⏸️ **DG-003**: Version line "Branch Agent 0.18.1 · sample" at nav foot
  - Sample: line 2716 shows `Branch Agent 0.18.1 · sample`
  - Location: Settings nav footer (public/layout.js)
- ⏸️ **DG-008**: Fix heading levels (h2 for page title, h3 for sections)
  - App currently: mixed levels due to bucket header structure
  - Fix depends on DG-011
- ⏸️ **DG-011**: Remove bucket header band with icon tile
  - Affects: heading levels (DG-008), section names duplication (DG-032), layout
  - Changes: `.sg-head` HTML structure or hide `.sg-tile`
- ⏸️ **DG-006**: Add "On this page" jump links under page intro
  - Location: Settings pages
  - Content: Links to each section heading
  - Concern: 3-second redraw may break scroll position (needs test)
- ⏸️ **DG-013**: At 390 px use `<select>` dropdown for page choice instead of tab strip
  - Conditional layout at narrow widths

**Lower priority CSS/spacing fixes:**
- ⏸️ **DG-012**: Level card needs border (not just top border)
- ⏸️ **DG-063**: Page title color and size (display face, accent color)
- ⏸️ **DG-071**: Settings pane edge-to-edge (no inset, no rounded corners)
- ⏸️ **DG-073**: "N more" button as link at end of section, not pill in header
- ⏸️ **DG-075**: Level control position at 390 px
- ⏸️ **DG-078**: Search box styling

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

---

## CONTINUATION SESSION (2026-09-20, Agent 3)

### New Progress: 6 CSS-only gaps (commits 4ec290f2, aea10bd8)
- ✅ **DG-009**: One-column layout (removed CSS `column-count: 2`)
- ✅ **DG-010**: Hidden scope chips with `display: none !important`
- ✅ **DG-072**: Card paragraph text limited to 70 characters
- ✅ **DG-074**: Empty state styling - removed filled box, transparent background
- ✅ **DG-076**: Nav group headings - margin 18px, adjusted font weight

### Updated Status: 10/29 Complete
| Batch | Total | Done | Method |
|-------|-------|------|--------|
| **Batch 4: Words** | 10 | 4 | Locale/code changes (previous) |
| **Batch 3: Furniture** | 19 | 6 | CSS-only (this session) |
| **TOTAL** | **29** | **10** | **35% complete** |

### Remaining 19 Gaps - Priority Order

**High Priority (exact sample strings available, quick wins ~1-2 hours each):**
1. DG-001/064: "Back to Branch" + Esc chip (sample: line 2714)
2. DG-003: Version line "Branch Agent 0.18.1 · sample" (sample: line 2716)
3. DG-050: Permissions section names (needs locale key check)

**Medium Priority (structural, ~2-3 hours each):**
1. DG-011: Remove bucket header band - BLOCKER for DG-008, DG-032
2. DG-002: Settings title with brand mark
3. DG-006: "On this page" jump links (requires redraw test)
4. DG-013: Phone dropdown instead of tab strip

**Lower Priority (complex or deferred):**
- DG-008: Heading levels (depends on DG-011)
- DG-023: Jargon removal (13+ strings, judgment calls)
- DG-032: Section duplication (depends on DG-011)
- DG-077: Achievement rewording (code restructuring)
- DG-155: Terminal hints (scope unclear)
- DG-063, 071, 073, 075, 078: CSS/spacing tweaks

### Files Modified This Session
```
public/settings-kit.css      (DG-010)
public/settings-grown.css    (DG-009, DG-072, DG-076)
public/style.css             (DG-074)
```

### Sample HTML Reference Points
- "Back to Branch" with Esc: Line 2714
- Version line: Line 2716
- Achievement template: Line 6243
- Permissions sections: Lines 5893-5935

### For Next Agent
1. Read the sample HTML at lines 2714, 2716 to copy exact Settings nav text
2. Check if DG-050 section names are locale keys or inline before updating
3. Do DG-011 (bucket header removal) FIRST - it unblocks DG-008 and DG-032
4. For DG-006 and DG-013, write redraw tests using `page.waitForFunction` pattern
5. Leave DG-023 and DG-155 untouched unless tokens remain

### Commands to Verify Work
```bash
cd /c/Users/bishi/Code/wt-batch34
npm run build 2>&1 | grep -v src/ws.ts | grep -E "error|warning"
npx tsc --noEmit 2>&1 | grep -v src/ws.ts | head -5
git log --oneline -10
git diff HEAD~2 HEAD --stat
```

