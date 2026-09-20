# Batch 1: Control renderers (sample parity)

Branch: `mac7/batch1-controls`
Gaps: **DG-015–DG-018, DG-021–DG-022, DG-054, DG-106, DG-133, DG-136**

## Checklist

- [ ] Measure baseline control counts on all 13 Settings pages
- [ ] Implement switch renderer (convert 102 tick boxes → `.sw` input[type=checkbox])
- [ ] Implement segmented renderer (convert segmented dropdowns → three-way button group)
- [ ] Standardize three-way wording to "Off · When needed · On" everywhere (DG-017)
- [ ] Wire glass-select to all 294 native `<select>` elements (DG-018)
- [ ] Add `accent-color` CSS to all range inputs (DG-021)
- [ ] Implement themed file picker button (DG-022)
- [ ] Test 3-second refresh survival (select remains open with focus)
- [ ] Run test suite
- [ ] Measure final control counts on all 13 Settings pages
- [ ] Create final report with before/after counts

## Baseline counts

Running baseline counter script to measure before state...

## Implementation notes

- Switches: styled native `<input type="checkbox" class="sw">` with `role="switch"` (no behavior change)
- Segmented: custom button group renderer (three buttons) replacing native dropdowns  
- Glass dropdown: existing `glass-select.js` just needs to be ensured it reaches all 294 selects
- Redraw safety: verify Settings selects survive 3s refresh cycle as same DOM nodes
