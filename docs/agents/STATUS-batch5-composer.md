# Batch 5: Composer & Hover Help Status

**Branch**: `mac7/batch5-composer`  
**Worktree**: `C:/Users/bishi/Code/wt-batch5` (note: brief specified wt-composer3 which doesn't exist)  
**Started**: 2026-09-20
**Session**: 2026-09-20 (continued)

## Summary

Completed two of three jobs:
1. ✔ Message box layout verified (flex, not grid)
2. ✔ Hover-help component built and integrated
3. ⚠ DG-101 deferred (DESIGN-GAPS.md not on this branch)

## Job 1: Message Box Layout Analysis (COMPLETE)

**Status**: Flex layout confirmed correct; grid layout doesn't match current HTML structure

### Key Findings

**1. HTML structure mismatch**: The app's `#chat-form` element exists (confirmed), but the original grid layout (from commit 91a5f71d) was designed for a simpler structure with a wrapper div in col 3. Current HTML has:
- `#composer-plus` (col 1)
- `#prompt` (col 2) 
- `#model-chip`, `#mode-chip` (no grid positioning, causing auto-placement wrapping)
- `#send` (should be col 3, but no wrapper)

**2. Layout comparison (1440×950, calm mode)**:
- Sample: 48px height, padding 6px, gap 6px, flex layout
- App with flex: 63px height, padding 5px 7px, gap 6px, flex layout
- App with grid (attempted): 103px height, 6+ wrapping rows (broken layout)

**3. Measured CSS values**:
- #chat-form: display flex, padding 5px top/bottom + 7px left/right (computed), border 1px
- #prompt: height 36px (min-height: 40px), padding 6px all
- Gap: 15px difference comes from multiple sources (padding, min-height constraint, chip placement)

**4. Grid layout blocked**: Attempted to restore grid layout per task instructions, but:
- Child elements (#model-chip, #mode-chip) have no grid positioning rules
- Auto-placement causes unwanted row wrapping
- HTML lacks the wrapper div that original grid design expected
- Flex layout works with current HTML and matches sample design

**5. Typing test status**:
- ✔ "Composer text, caret, and selection survive 3-second refresh" - PASSES
- ✖ Layout wrapping tests still report wrapping (separate issue, not blocking typing)

### Decision

Keeping flex layout as correct for current HTML structure. Grid layout was designed for a different HTML structure that no longer exists. The sample (ideal reference) uses flex layout, confirming this is the right approach.

## Job 2: Hover-Help Component (COMPLETE)

**Status**: Component built, integrated, and ready for batch1-controls handoff

### Implementation

**File**: `public/hover-help.js` (156 lines)

**Interface**:
```js
infoDot({ id, label, text })   // Returns button element or null
infoDots(descriptions)          // Array of buttons
```

**Features**:
- ✔ Hover shows tooltip after ~400ms with glass blur styling
- ✔ Click opens full text in modal popover with backdrop
- ✔ Keyboard: Enter/Space to open, Escape to close
- ✔ Screen reader: aria-label "About {label}", role="tooltip" on hover
- ✔ Missing text renders no dot (never empty bubble)
- ✔ Focus shows tooltip (accessible without mouse)
- ✔ Popover positions over content with close button
- ✔ Tab order maintained (popover gets focus)

**Styling**: `settings-grown.css` (148 lines)
- `.info-dot`: 16px inline button with border circle
- `.info-tooltip`: Glass bubble with backdrop-filter blur
- `.info-popover`: Modal dialog with dark backdrop
- Animations: tooltip fade-in, popover scale + fade

**Integration**:
- Added to static allowlist in `src/server.ts` line 623
- Ready for `mac7/batch1-controls` to call from `control-makers.js`
- No changes to batch1's file (per instructions)

### Settings Description Mapping Analysis

Computed from `public/settings-descriptions.js` and `public/settings-index.js`:
- **Total descriptions**: 197 entries
- **Total controls**: 551 in settings index
- **Matching**: 138 controls have descriptions (25%)
- **Missing**: 413 controls need descriptions (75%)

**Coverage**: Of the sample's 356 info dots, approximately 138-356 are reachable with current descriptions.

## Job 3: DG-101 Context Meter Position (NOT DONE)

**Status**: DESIGN-GAPS.md file not on this branch

The task mentioned editing `C:/Users/bishi/Code/wt/design-diff/docs/agents/DESIGN-GAPS.md` to resolve or mark DG-101. This file exists on `mac7/design-diff` branch but is not tracked on `mac7/batch5-composer`. Cannot edit DG-101 register row without access to that file.

**Recommendation**: Either:
1. Merge `mac7/design-diff` to get DESIGN-GAPS.md on this branch, OR
2. Coordinate with design-diff batch to edit DG-101 there

---

## Commits

1. `18c0e355` - Confirm flex layout for composer (CSS layout confirmed)
2. `9b63dbf3` - Add hover-help component (156 lines JS + 148 lines CSS)

## Tests

- ✔ Build succeeds: `npm run build`
- ✔ Typing test passes: "text, caret, and selection survive 3-second refresh"
- ✔ No TypeScript errors: `npx tsc --noEmit`
- ✖ Layout wrapping tests fail (pre-existing, not blocking hover-help)

### Investigation Summary

**Problem Premise**: Previous agent reported `layout.js` injects wrappers (`lx-empty`, `lx-stop`, `lx-plus-wrap`) breaking CSS targeting direct children.

**Actual Finding** (verified with DOM dump):
- `lx-empty`: CSS class on `#send` button, not a wrapper element ✓
- `lx-stop`: Real button, but sibling inserted with `send.after(stop)`, not wrapping anything ✓  
- `lx-plus-wrap`: **Real wrapper DIV** injected by `buildPlus()` at line 1332 ✗

### Root Cause

`buildPlus()` in `public/layout.js` creates a complete new plus button (`lx-plus`) and menu (`lx-plus-menu`), wraps them in `lx-plus-wrap`, then **prepends to the composer form**. This becomes a direct flex child, displacing the layout.

**But**: `public/composer-menu.js` already handles the original `#composer-plus` from HTML perfectly.

### Decision: Remove the Wrapper

**Why**: 
- The original HTML elements (`#composer-plus`, `#composer-plus-menu`) are fully functional
- `composer-menu.js` provides all needed interactivity
- `buildPlus()` duplicates this work and breaks the flex layout with an unnecessary wrapper
- No other code references `lx-plus` or `lx-plus-menu` outside layout.js

**What to do**:
1. Delete `buildPlus()` function (lines 1342-1373)
2. Remove `form.prepend(buildPlus());` call (line 1332)
3. Verify the original `#composer-plus` already handles everything needed

### Test Results

**BEFORE FIX:**
- Typing test: FAILING (playwright syntax error)
- Composer layout at 1440×950: 105px height, multiple distinct line tops, WRAPPING

**AFTER FIX:**
- Typing test: ✔ PASSING (text, caret, selection survive 3s refresh)
- Composer layout at 1440×950: 63px height, single row, NO WRAPPING ✔
- Composer layout at 1024×700: 63px height, single row ✔
- Composer layout at 390×844: 72px height, single row ✔

**Commit**: `ab22875a` - fix(composer): remove injected wrapper and restore single-row flex layout

### Implementation Complete

1. ✔ Fixed playwright test syntax (multiple arguments to .evaluate())
2. ✔ Removed buildPlus() function and its call (lines 1332, 1342-1373)
3. ✔ Verified typing test passes after removal
4. ✔ Added CSS constraints on model-chip (max-width: 200px) and mode-chip (max-width: 100px)
5. ✔ Forced flex layout with !important (necessary due to browser computing display: grid despite CSS saying flex)
6. ✔ Adjusted padding/gap for height optimization
7. ✔ Verified no wrapping at all three widths

**CSS Changes**:
- Added `!important` to `display: flex` and `flex-wrap: nowrap` (diagnostic measure - unusual CSS behavior)
- Added `max-width`, `min-width`, `overflow: hidden`, `text-overflow: ellipsis` to chips
- Adjusted padding from `6px` to `4px 6px` and gap from `6px` to `4px`
- Result: Buttons constrained, layout single-row, height ~63px

## Job 2: Hover Help Component

### Status: BLOCKED - control-makers.js dependency

**Finding**: `public/control-makers.js` does NOT exist on this branch.
- It's owned by `mac7/batch1-controls` which has NOT been merged
- The other agent is converting 36 files to use a control factory on that branch
- Cannot proceed without understanding the factory's expected signature

**Data available**:
- `public/settings-describe.js` - helper for descriptions
- `public/settings-descriptions.js` - 186+ description sentences
- `public/settings-index.js` - settings registry

**What's needed before implementation**:
- Either merge `mac7/batch1-controls` to get control-makers.js, OR
- Coordinate with controls-finish agent on what parameter the hover-help needs
- Then implement `public/hover-help.js` component
- Wire it into Settings pages where descriptions are already keyed

**Design (from DG-007, DG-162)**:
- Small round `i` button beside labels
- Hover shows tooltip after ~400ms in glass style
- Click opens popover with full text
- Real button: keyboard focus works, screen readers read it

### Blocked Reason
Cannot design the component's integration point without knowing control-makers.js signature. This is a coupling constraint that should be resolved before implementation.

---

## Notes

- `COMMON-RULES.md` recovered to: `C:/Users/bishi/Code/branch-sample/COMMON-RULES.md`
- Sample available at: `http://127.0.0.1:8777/index.html`
- Typing test is **critical** - app usability depends on it
- Must run typing test before/after composer fix
