# Batch 1 Control Conversions - Remaining Files

## Pattern 1: Three-way switches (Off / When needed / On)
These can be converted to `segmented()` directly.

- devices.js (modeSwitch)
- folder-trust.js
- heartbeat.js  
- learning-more.js
- never-break.js
- os-sandbox.js
- personal.js
- safety-extras.js
- telegram-setup.js
- usage-report.js

## Pattern 2: Dynamic device/option pickers
These may need special handling or can use dropdown() with all options provided at render.

- devices.js (composer-device) - may need to update options dynamically
- skill-installs.js
- settings-kit.js
- recordings.js

## Pattern 3: Multi-option selects (not three-way)
These can use dropdown() to match sample's button-group pattern.

- interop.js (2 selects)
- knobs.js (3 selects)
- knowledge.js
- model-savings.js (2 selects)
- prompt-library.js (3 selects)
- reach.js (2 selects)
- trunks.js (2 selects)
- vault-autofill.js

## Status
- ✓ channel-setup.js (3 selects) - DONE
- ✓ commands.js (1 select) - DONE
- → Next: devices.js, folder-trust.js, heartbeat.js, ...
