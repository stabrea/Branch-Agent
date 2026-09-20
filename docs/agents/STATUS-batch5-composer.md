# Batch 5: Composer & Hover Help Status

**Branch**: `mac7/batch5-composer`  
**Worktree**: `/c/Users/bishi/Code/wt-batch5`  
**Started**: 2026-09-20  

## Job 1: Unblock the message box

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

### Test Results Before Fix

Typing test: FAILING (playwright .evaluate() argument syntax error in test, not in app)
Composer layout at 1440×950: 105px height, 5 distinct line tops, WRAPPING

### Implementation Plan

1. Run typing test on current code (fix test if needed)
2. Remove buildPlus() completely
3. Test typing again - MUST PASS
4. Measure layout at 1440×950, 1024×700, 390×844
5. Verify no wrapping, height ~48px

## Job 2: Hover Help Component

- `public/control-makers.js` does NOT exist on this branch (owned by `mac7/batch1-controls`)
- Will note in report that integration parameter needed if control factory is mandatory
- Data ready: `settings-describe.js` and `settings-descriptions.js` hold 186+ sentences
- 356 controls in sample, 0 in app currently

---

## Notes

- `COMMON-RULES.md` recovered to: `C:/Users/bishi/Code/branch-sample/COMMON-RULES.md`
- Sample available at: `http://127.0.0.1:8777/index.html`
- Typing test is **critical** - app usability depends on it
- Must run typing test before/after composer fix
