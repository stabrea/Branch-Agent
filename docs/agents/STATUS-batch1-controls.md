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
- `segmented({id, options, value, onChange})` → button group with `aria-pressed`
- `dropdown({id, options, value, onChange})` → `<select class="glass">`

Plus `/public/control-styles.css` with styling for all three types.

## Proof-of-concept: add-ons.js converted ✓

Converted `public/add-ons.js` (7 committers):
- 3 controls: 2 switches (wallEveryPlugin, windowsWithoutWall) + 1 segmented (modes per part)
- Behavior unchanged: same save callbacks, same values stored
- Import: `import { switchControl, segmented } from "/control-makers.js"`
- Build: success ✓

Pattern demonstration:
```javascript
// Old: const select = document.createElement("select"); ...
// New: const control = segmented({id, options, value, onChange});
```

## Remaining work

35 files to convert following add-ons.js pattern:
- public/approval-reviewer.js
- public/asks.js
- public/app.js
- [32+ more files with createElement("select") or createElement("input")]

Each is a straightforward refactor, no behavior change.

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
