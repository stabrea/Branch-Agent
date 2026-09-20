# Batch 3&4 Sample Parity Programme - Status Log

## Task
Close batches 3 and 4 of the sample-parity programme:
- Batch 3: Settings page furniture (19 gaps) - DG-001–DG-003, DG-006, DG-008–DG-013, DG-063–DG-064, DG-071–DG-076, DG-078
- Batch 4: The words (10 gaps) - DG-019, DG-023, DG-032, DG-050, DG-077, DG-137, DG-150, DG-152–DG-153, DG-155

## Critical Advisory Notes (must preserve)

### Label-vs-Value Trap (from Advisor, 2026-09-20)
**DG-150 and DG-017 rename things that may be keys, not just labels.**

Pattern verified: `[value, locale_key, fallback]`
- Stored values (in database): "off", "when-needed", "on" — DO NOT CHANGE
- Display labels (in locale files and inline fallbacks): "Only when it is needed" → "When needed" — OK TO CHANGE
- Files with inline fallbacks (19 total): add-ons.js, asks.js, autonomy.js, coding.js, commands.js, context-files.js, dashboard/card.js, devices.js, flows-boards.js, interop.js, learning-loop.js, learning-more.js, people-admin.js, personal.js, prompt-library.js, reach.js, etc.
- Settings preset stored values in settings-kit.js:60: "read-only", "ask-before-changes", "workspace", "off" — DO NOT CHANGE

**Verification complete:** changing en.json + fr.json + inline fallbacks preserves all stored settings. "A setting that was off stays off" rule is satisfied.

### 3-Second Redraw Bug (affects DG-006 and DG-013 only)
Tests for state that holds across redraws must:
1. Perform action (scroll to section, open tab strip)
2. Wait >3s for rebuild to trigger
3. Assert state survived

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

### DG-151 Constraint  
Lockdown (moving it to mode menu) is NOT in this batch — DG-151 is not assigned.
When DG-150 reorders modes, leave 5th position empty for Lockdown.
Current ORDER: `["ask", "plan", "auto", "full"]` → New ORDER: `["auto", "ask", "plan", "full"]`

### DG-152 Number Keys (display only, no handlers)
Sample shows: `1` `3` `4` chips. Map to positions in display order (not contiguous for good reason in sample).
Do NOT wire new key handlers — this is display-only. Confirm `Shift+Tab` cycling already exists before promising it in DG-153 footer.

## Sample Location
http://127.0.0.1:8777/index.html (served from C:/Users/bishi/Code/branch-sample/)

## Progress
- [x] DG-019, DG-137: CSS field labels monospace → body font
- [x] DG-150, DG-152, DG-153: Mode picker reorder, rename, number keys, footer
- [ ] DG-023, DG-032, DG-050, DG-077, DG-155: Remaining batch 4 wording (lower priority)
- [ ] Batch 3 structural (DG-001–DG-003, DG-006, DG-008–DG-013, DG-063–DG-064, DG-071–DG-078)
- [ ] Test suite (before/after screenshots, redraw tests for DG-006/013)
- [x] Initial push to mac7/batch34-settings (commits 1-2)
