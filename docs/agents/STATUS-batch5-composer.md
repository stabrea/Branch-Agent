# Batch 5: Composer & Hover Help Status

**Branch**: `mac7/batch5-composer`  
**Worktree**: `C:/Users/bishi/Code/wt-batch5` (was wt-composer3, which doesn't exist)  
**Started**: 2026-09-20
**Session**: 2026-09-20 (continued)

## Job 1: Verify the message box layout (COMPLETE)

### Finding: Grid vs Flex Layout Analysis

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
