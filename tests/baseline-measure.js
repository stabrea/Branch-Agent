// Batch 1 baseline measurement
// Run this in the browser console with the app open:
// 1. Open DevTools console
// 2. Paste this entire script
// 3. Run: await measureBaseline()

globalThis.measureBaseline = async function measureBaseline() {
  const results = {};

  for (const p of ['general','assistant','appearance','permissions','advanced','data','voice']) {
    window.openSettings(p);
    await new Promise(r => setTimeout(r, 500));

    results[p] = {
      nativeSelects: document.querySelectorAll('select').length,
      switches: document.querySelectorAll('input.sw,[role=switch]').length,
      tickBoxes: document.querySelectorAll('input[type=checkbox]:not(.sw)').length,
      segmentedButtons: document.querySelectorAll('.seg button,[role=group] button[aria-pressed]').length,
    };

    console.log(`${p}:`, results[p]);
  }

  console.log('\nFull results:', JSON.stringify(results, null, 2));
  return results;
};

console.log('Baseline measurement ready. Run: await measureBaseline()');
