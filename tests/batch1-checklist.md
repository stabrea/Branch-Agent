# Batch 1: Control Parity Implementation Checklist

## Phase 1: Foundation (COMPLETE)
- [x] Create control-makers.js factory module
  - switchControl() for toggles
  - segmented() for three-way/multi-option with .value support
  - dropdown() renders button groups (not native select)
- [x] Add control-styles.css
- [x] Register in server.ts and index.html
- [x] Convert add-ons.js (proof of concept)
- [x] Add .value getter/setter to segmented() for compatibility

## Phase 2: File Conversions (IN PROGRESS)
Files converted (4/35):
- [x] add-ons.js (proof of concept)
- [x] approval-reviewer.js (mode segmented, connection kept as select)
- [x] asks.js (switchFor using segmented)
- [x] autonomy.js (choice() helper using dropdown)

Remaining (31 files):
- [ ] channel-setup.js (3 selects)
- [ ] coding.js (2 selects)
- [ ] comfort.js (2 selects)
- [ ] commands.js (1 select)
- [ ] devices.js (2 selects)
- [ ] flows-boards.js (1 select)
- [ ] folder-trust.js (1 select)
- [ ] heartbeat.js (1 select)
- [ ] interop.js (2 selects)
- [ ] knobs.js (need to check)
- [ ] knowledge.js (need to check)
- [ ] learning-more.js (need to check)
- [ ] model-savings.js (need to check)
- [ ] never-break.js (need to check)
- [ ] os-sandbox.js (need to check)
- [ ] personal.js (need to check)
- [ ] prompt-library.js (need to check)
- [ ] reach.js (need to check)
- [ ] recordings.js (need to check)
- [ ] safety-extras.js (need to check)
- [ ] settings-kit.js (need to check)
- [ ] skill-installs.js (need to check)
- [ ] telegram-setup.js (need to check)
- [ ] trunks.js (need to check)
- [ ] usage-report.js (need to check)
- [ ] vault-autofill.js (need to check)
- [ ] (16 more files not yet verified)

## Phase 3: Critical Tests (NEXT)
- [ ] Redraw survival test (open control, wait 4+ seconds, assert still open)
- [ ] Baseline measurement (run measurement script on all 7 Settings pages)
- [ ] DG gaps walkthrough (DG-054, DG-106, DG-133, DG-136)

## Phase 4: Final Conversions
- [ ] Convert remaining 31 files
- [ ] Re-measure control counts
- [ ] Verify all gaps closed

## Phase 5: Cleanup (Batch 4)
- [ ] Standardize three-way wording per file (DG-017)
- [ ] File picker HTML wiring (DG-022)
