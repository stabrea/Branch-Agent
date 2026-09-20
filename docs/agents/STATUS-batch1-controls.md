# Batch 1: Control renderers (sample parity)

Branch: `mac7/batch1-controls`
Gaps: **DG-015–DG-018, DG-021–DG-022, DG-054, DG-106, DG-133, DG-136**

## RESCOPED (after coordinator review)

**Previous approach (REVERTED):** Added decorator that runs AFTER render, causing flicker on 3s redraw cycle — the exact bug the brief warns about.

**Correct approach:** Change renderers at their SOURCE so correct markup is emitted the first time. No decorators, no redraw races.

## Checklist

- [x] Create control counter tests (batch1-count-controls.mjs, batch1-count-simple.mjs)
- [ ] Find where Settings pages render controls (locate the source renderers)
- [ ] Implement switch renderer at source (emit `<input type="checkbox" class="sw" role="switch">`)
- [ ] Implement glass select at source (ensure `.glass` class or replace with custom renderer)
- [ ] Walk DG-054 (specific screenshot)
- [ ] Walk DG-106 (specific screenshot)
- [ ] Walk DG-133 (specific screenshot)
- [ ] Walk DG-136 (specific screenshot)
- [ ] Measure baseline control counts (proper test, own instance)
- [ ] Add CSS for accent-color on ranges (DG-021)
- [ ] Build and verify no errors
- [ ] Test 3-second refresh survival (select open, focus in it, wait 4s, assert both survive)
- [ ] Measure final control counts
- [ ] Create final report with before/after counts
- [ ] (Defer to batch 4): DG-017 (standardize three-way wording)
- [ ] (Defer to batch 4): DG-022 (file picker HTML wiring)

## Baseline counts

Awaiting proper test setup and source renderer analysis...

## Implementation notes (revised)

- **Switches**: Change source renderer to emit `<input type="checkbox" class="sw" role="switch">` from the start
  - Preserves checked property, change event, label[for] relationships
  - No post-render decoration (no redraw race condition)
  
- **Glass dropdowns**: Either:
  - Ensure `.glass` class is added at render time (not post-render), OR
  - Replace native `<select>` renderer with custom glass dropdown renderer
  
- **Segmented controls**: Change source to emit button groups instead of native dropdowns
  - Three buttons: Off | When needed | On
  
- **Range styling**: Add CSS with `accent-color` property (no markup change needed)
  
- **Redraw safety**: By changing source renderers, controls are emitted correctly on every redraw
  - No MutationObserver needed
  - No flicker or race condition
