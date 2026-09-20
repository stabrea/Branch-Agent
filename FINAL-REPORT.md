# Batch 3&4 Sample Parity Programme - Final Report

**Task Date:** 2026-09-20  
**Branch:** mac7/batch34-settings  
**Base:** origin/mac/cross-platform (0c9e254d)  
**Sample:** http://127.0.0.1:8777/index.html

## Completed Work (4 of 29 gaps)

### Batch 4 Wording Changes
✅ **DG-019**: Field labels CSS changed from monospace to body font
- File: public/style.css line 169
- Changed: `font-family: var(--font-mono)` → `font-family: var(--body)`
- Impact: All `<label>` elements now use body font instead of monospace
- Verification: Sample reference confirmed (register prose)

✅ **DG-137**: Same CSS change applies to background card labels
- Same CSS rule impacts background labels across all Settings pages
- Verification: Sample reference confirmed (register prose)

✅ **DG-150**: Mode picker order changed  
- File: public/conversation-mode.js line 23
- Changed: `ORDER = ["ask", "plan", "auto", "full"]` → `["auto", "ask", "plan", "full"]`
- Mode labels renamed (both en.json and fr.json):
  - "mode.plan": "Plan" → "Plan first"
  - "mode.full": "Full access" → "No approvals"
  - "mode.fullWarning" and "mode.fullYes" updated to match
- Files changed: public/conversation-mode.js, public/locales/en.json, public/locales/fr.json
- Verification: Locale files verified, ORDER mapping checked (no persistence)

✅ **DG-152**: Number key indicators added to mode menu
- File: public/conversation-mode.js in choiceItem() function
- Added: `<span class="mode-keys">` with keyboard shortcuts (1, 3, 4)
- Mapping: ask→1, plan→3, full→4
- Display-only, no key handlers wired
- Verification: Implementation matches spec (register prose)

✅ **DG-153**: Footer text added to mode picker menu  
- File: public/conversation-mode.js in paintMenu() function
- Added two-line explanatory footer about mode choices and keyboard shortcuts
- Text interpolates locale keys to stay synchronized with mode renames
- Note: DG-151 (Lockdown in menu) not in this batch; 5th menu position remains empty

### Critical Advisory Compliance
- ✅ Label-vs-value trap: Verified locale file changes preserve stored values
- ✅ Three-second redraw: No state-holding code in completed work; DG-006/013 need tests
- ✅ No bare npm test: All work avoids triggering build  
- ✅ Semantic collision noted: "No approvals" rename documented for collision check

## Uncompleted Work (25 of 29 gaps)

### Batch 4: Remaining Wording Changes (5 gaps)
**Status:** Untouched - require exact character-by-character matching from sample

**DG-023**: Jargon removal
- Strings to change: "BRANCH_MODEL_PRESETS in the launch environment", "Danger zone", "Under the hood", "Client id", "Issuer address", "The number of the thing to label", "e.g. client-site"
- Load-bearing terms that must survive: BRANCH_MODEL_PRESETS env var name, (seconds), (hours) units
- Files affected: multiple public/*.js and en.json/fr.json
- Coordinator guidance: Copy plain-word replacements **exactly** from sample
- **Blocker:** Sample text not yet extracted for exact matching

**DG-032**: "Who your assistant is" duplication  
- Current state: Bucket header AND card header both read "Who your assistant is"
- Sample state: Single heading only
- Locale keys involved: settings.card.who-your-assistant-is, settingsGrown.bucket.assistant.who
- **Blocker:** Need to determine which to remove vs keep vs rename

**DG-050**: Permissions section names
- Current: "When Branch checks with you" (bucket) › "When to check with me", "How fast one conversation may work", "Emergency stop", "A second look before approvals"
- Sample order/names not yet extracted
- Files: public/locales/en.json and fr.json
- **Blocker:** Sample section names need exact extraction

**DG-077**: Achievement wording  
- Current: "3 Settings pages", "6 Settings pages" (count-based)
- Sample: "Visited Models", "Visited Secrets", "Visited Instructions & personality" (page-based)
- Blocker: Need to verify achievement records carry page id before making change
- Risk: Data structure change may be required, not just string edit

**DG-155**: Terminal key hints wording
- Current: Has its own key line (line 1663 in app.js)
- Sample wording: "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops the task · Ctrl+D leaves" and "Esc, then 1-5 (or Alt+1 to Alt+5): Conversation, Inbox, Automations, Library, Customize · Ctrl+K or /: find anything"
- Files: public/app.js (terminal layout) and public/terminal-*.ts
- **Blocker:** Sample text needs exact extraction and verification of current structure

### Batch 3: Settings Page Furniture (19 gaps)

**Status:** Untouched - all are structural/CSS changes requiring sample verification

**Components missing or malformed:**
- DG-001: Back link with Esc key chip
- DG-002: Settings page title with mark (larger display text)
- DG-003: Version line at nav footer
- DG-006: "On this page" jump links (needs redraw test for 3s survival)
- DG-008: Heading levels (h2 for page, h3 for sections)
- DG-013: 390px tab strip instead of dropdown (needs redraw test for scroll survival)

**CSS-only changes:**
- DG-009: Two columns → one full-width (note: owner approved two columns elsewhere)
- DG-010: Remove "scope" chips from cards
- DG-011: Fix bucket header (remove icon tile, move "N more" link)
- DG-012: Add border box to level control
- DG-063: Page title sizing
- DG-064: Esc key chip in search box
- DG-071: Remove pane inset, make edge-to-edge
- DG-072: Limit card text to ~70 chars
- DG-073: Move "N more with Advanced" from header pill to end-of-section link
- DG-074: Remove filled box from empty state
- DG-075: Level control positioning at 390px
- DG-076: Nav group headings size and spacing
- DG-078: Search box height and placeholder font

## Next Steps for Fresh Agent

1. **For remaining batch 4 rows:**
   - Read sample at http://127.0.0.1:8777/index.html
   - Extract exact strings (including glyphs, separators, capitalization) for each row
   - Make targeted edits one row at a time
   - Test build (npm run build)
   - Commit per row or per page

2. **For batch 3 work:**
   - Generate before screenshot (1440×950 light)
   - Implement structural changes row by row
   - Generate after screenshot  
   - Add redraw tests for DG-006 and DG-013
   - Test: npm run build, npx tsc --noEmit, then run tests individually

3. **Critical points:**
   - Never bare `npm test` - use `npm run build` then test individual files
   - All strings must match sample character-for-character
   - Three-way control always: "Off · When needed · On" (glyph·space)
   - Day/night: "☾ Moonlight" and "☀ Daylight" (glyph·space·word)
   - Keep `docs/configuration.md` updated for new settings

## Files Changed
- ✅ public/style.css (CSS only)
- ✅ public/conversation-mode.js (JS struct + locale interpolation)
- ✅ public/locales/en.json (mode strings)
- ✅ public/locales/fr.json (mode strings)
- ✅ BATCH34-STATUS.md (git-tracked notes)

## Commits Made
1. docs: add batch 3&4 status with critical advisory notes (751280cf)
2. style(batch34-DG019-DG137): change field labels from monospace to body font (c1b18849)
3. feat(batch34-DG150-DG152-DG153): reorder modes, rename, add number keys and footer (d53d38ee)
4. docs: update batch 34 status - 4 of 10 batch 4 gaps complete (032b19c8)

## Sample & Briefs Status
- ✅ Sample recovered: http://127.0.0.1:8777/index.html
- ✅ COMMON-RULES.md: C:/Users/bishi/Code/branch-sample/COMMON-RULES.md
- ✅ PROGRAM-SAMPLE-PARITY.md: C:/Users/bishi/Code/branch-sample/PROGRAM-SAMPLE-PARITY.md
- ✅ DESIGN-GAPS.md: C:/Users/bishi/Code/wt/design-diff/docs/agents/DESIGN-GAPS.md
- ⚠️ Paired screenshots: LOST (auto-purged on machine restart; recovered from other sources not available)

## Semantic Issues Flagged

**DG-150 semantic collision (documented, not critical):**
- `mode.full` now reads "No approvals" but refers to conversation behavior (what this conversation can do without asking)
- `policy.preset.off` also reads "No approvals" but refers to approval policy (what owner pre-approves globally)
- Both labels may render on same screen; potential UX confusion
- Status: Rename applied per sample; documented for owner awareness

**DG-077 data uncertainty:**
- "Visited Models" wording requires achievement record to carry page id
- Current count-based implementation ("3 Settings pages") suggests page id may not be stored
- Risk: Renaming without data support breaks tracking
- Recommendation: Check schema before proceeding with this row
