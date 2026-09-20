# Batch 1: Control renderers (sample parity)

Branch: `mac7/batch1-controls`
Gaps: **DG-015–DG-018, DG-021–DG-022, DG-054, DG-106, DG-133, DG-136**

## Discovery: 36 files, no shared control factory

Each of 36 files invents its own controls with `createElement()`. This explains the register's findings:
- Four different option orders for three-way switches
- Five different wordings ("Only when it is needed" vs "When needed" vs "Off only when it is needed / On")
- No consistency across the codebase

## Solution: Three control makers

Created `/public/control-makers.js` with:
- `switchControl({id, checked, onChange})` → `<input type="checkbox" class="sw" role="switch">`
- `segmented({id, options, value, onChange})` → button group with `aria-pressed` + .value property
- `dropdown({id, options, value, onChange})` → `<div role="group">` with button group (NOT native select)

**Important correction (from coordinator review):**
- Sample has ZERO native `<select>` elements on any Settings page
- All dropdowns in sample use button groups (like appearance.js choiceButton pattern)
- dropdown() now returns `<div class="choice-row">` with `<button class="choice">` elements
- Styling reuses existing shell.css .choice and .choice-row classes

Plus `/public/control-styles.css` with styling for switches, segmented controls, and ranges.

## Phase 1: Foundation complete

- [x] control-makers.js with corrected dropdown() (button groups, not select)
- [x] control-styles.css styling
- [x] .value property support on segmented for compatibility
- [x] add-ons.js converted (proof of concept)

## Phase 2: File conversions in progress (4/35)

Converted:
1. add-ons.js (proof of concept) ✓
2. approval-reviewer.js (mode → segmented) ✓
3. asks.js (switchFor → segmented) ✓
4. autonomy.js (choice → dropdown) ✓

Next: 31 more files following the established patterns:
- File with choice() helper → update choice to use dropdown()
- File with createElement("select") directly → use dropdown() or segmented()
- File with checkboxes → use switchControl() where appropriate

## Phase 3: Critical tests (NEXT PRIORITY)

Before converting remaining 31 files:
- [ ] **Redraw survival test** (NON-OPTIONAL): Open add-ons.js dropdown, wait 4+ seconds through redraw cycle, verify still open/focused
- [ ] **Baseline measurement**: Count controls on all 7 Settings pages (before final conversions)
- [ ] **DG gap walkthrough**: Screenshots of DG-054, DG-106, DG-133, DG-136

## Checklist

- [x] Create control counter tests
- [x] Find where controls created (36 client-side files)
- [x] Implement switchControl() renderer
- [x] Implement segmented() renderer (Off | When needed | On)
- [x] Implement dropdown() renderer (class="glass")
- [x] Add CSS styling for all controls
- [x] Add accent-color for ranges (DG-021)
- [x] Prove pattern on one file (add-ons.js)
- [x] Build and verify no errors
- [ ] Convert remaining 35 files (next phase)
- [ ] Walk DG-054, DG-106, DG-133, DG-136 after conversions
- [ ] Measure baseline counts
- [ ] Test 3-second refresh survival
- [ ] Measure final counts
- [ ] (Defer to batch 4): DG-017 (standardize wording per file)
- [ ] (Defer to batch 4): DG-022 (file picker HTML wiring)
