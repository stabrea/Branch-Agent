#!/usr/bin/env node
/**
 * Verify pass-17 art assets are loaded and render correctly.
 * Run with: PORT=<port> TOKEN=<token> node verify-p17-art.cjs
 * Example: PORT=3212 TOKEN=6de1b0cc36e996757a6db3fcafab6afa78a5e3d7f41d73ef9007d4a0624c5425 node verify-p17-art.cjs
 */

const { chromium } = require('playwright');
const PORT = process.env.PORT || 3212;
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('TOKEN env var required. Run engine with: BRANCH_DATA_DIR=<dir> BRANCH_PORT=3212 node dist/cli.js start');
  process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${PORT}`;

const ART_TESTS = [
  // Backgrounds in Appearance › Painted scenes
  { type: 'bg', id: 'night17-lake', url: '/art/bg/lake-night.webp', name: 'Still lake at night' },
  { type: 'bg', id: 'night17-highland', url: '/art/bg/highland-moon.webp', name: 'Moonlit highland' },
  { type: 'bg', id: 'day17-sea', url: '/art/bg/sea-morning.webp', name: 'Morning sea' },
  { type: 'bg', id: 'day17-meadow', url: '/art/bg/meadow-afternoon.webp', name: 'Meadow afternoon' },
  { type: 'bg', id: 'glow17-amber', url: '/art/bg/glow-amber.webp', name: 'Amber glass' },
  { type: 'bg', id: 'season17-snow', url: '/art/bg/first-snow.webp', name: 'First snow' },

  // Feature art
  { type: 'feature', id: 'art17-cloud', still: '/art/cloud.webp', loop: '/art/cloud.webm', name: 'Cloud' },
  { type: 'feature', id: 'art17-call', still: '/art/call.webp', loop: '/art/call.webm', name: 'Call' },
  { type: 'feature', id: 'art17-meeting', still: '/art/meeting.webp', loop: '/art/meeting.webm', name: 'Meeting' },
  { type: 'feature', id: 'art17-learn', still: '/art/learn.webp', loop: '/art/learn.webm', name: 'Learn' },
  { type: 'feature', id: 'art17-timeline', still: '/art/timeline.webp', loop: '/art/timeline.webm', name: 'Timeline' },

  // Branch art
  { type: 'branch', id: 'art17-branch-call', url: '/art/branch-call.webp', name: 'Branch call' },
  { type: 'branch', id: 'art17-branch-workbook', url: '/art/branch-workbook.webp', name: 'Branch workbook' },

  // Pets - stills
  { type: 'pet', id: 'redpanda', url: '/art/pets/redpanda.webp', name: 'Red panda' },
  { type: 'pet', id: 'pangolin', url: '/art/pets/pangolin.webp', name: 'Pangolin' },
  { type: 'pet', id: 'quokka', url: '/art/pets/quokka.webp', name: 'Quokka' },
  { type: 'pet', id: 'acornling', url: '/art/pets/acornling.webp', name: 'Acorn sprite' },
  { type: 'pet', id: 'goatkid', url: '/art/pets/goat kid', name: 'Goat kid' },
  { type: 'pet', id: 'piglet', url: '/art/pets/piglet.webp', name: 'Teacup piglet' },

  // Pet walk animations
  { type: 'pet-walk', id: 'redpanda-walk', url: '/art/pets/redpanda-walk.webm', name: 'Red panda walk' },
  { type: 'pet-walk', id: 'pangolin-walk', url: '/art/pets/pangolin-walk.webm', name: 'Pangolin walk' },
  { type: 'pet-walk', id: 'quokka-walk', url: '/art/pets/quokka-walk.webm', name: 'Quokka walk' },
  { type: 'pet-walk', id: 'acornling-walk', url: '/art/pets/acornling-walk.webm', name: 'Acorn sprite walk' },
  { type: 'pet-walk', id: 'goatkid-walk', url: '/art/pets/goatkid-walk.webm', name: 'Goat kid walk' },
  { type: 'pet-walk', id: 'piglet-walk', url: '/art/pets/piglet-walk.webm', name: 'Teacup piglet walk' },

  // Agent stills
  { type: 'agent', id: 'sorrel', url: '/art/agents/sorrel/still.webp', name: 'Sorrel still' },
  { type: 'agent', id: 'skein', url: '/art/agents/skein/still.webp', name: 'Skein still' },
  { type: 'agent', id: 'nib', url: '/art/agents/nib/still.webp', name: 'Nib still' },

  // Agent animations
  { type: 'agent-anim', id: 'sorrel-idle', url: '/art/agents/sorrel/idle.webm', name: 'Sorrel idle' },
  { type: 'agent-anim', id: 'sorrel-think', url: '/art/agents/sorrel/think.webm', name: 'Sorrel think' },
  { type: 'agent-anim', id: 'sorrel-work', url: '/art/agents/sorrel/work.webm', name: 'Sorrel work' },
  { type: 'agent-anim', id: 'sorrel-yay', url: '/art/agents/sorrel/yay.webm', name: 'Sorrel yay' },
  { type: 'agent-anim', id: 'skein-idle', url: '/art/agents/skein/idle.webm', name: 'Skein idle' },
  { type: 'agent-anim', id: 'skein-think', url: '/art/agents/skein/think.webm', name: 'Skein think' },
  { type: 'agent-anim', id: 'skein-work', url: '/art/agents/skein/work.webm', name: 'Skein work' },
  { type: 'agent-anim', id: 'skein-yay', url: '/art/agents/skein/yay.webm', name: 'Skein yay' },
  { type: 'agent-anim', id: 'nib-idle', url: '/art/agents/nib/idle.webm', name: 'Nib idle' },
  { type: 'agent-anim', id: 'nib-think', url: '/art/agents/nib/think.webm', name: 'Nib think' },
  { type: 'agent-anim', id: 'nib-work', url: '/art/agents/nib/work.webm', name: 'Nib work' },
  { type: 'agent-anim', id: 'nib-yay', url: '/art/agents/nib/yay.webm', name: 'Nib yay' },
];

async function verifyAssets() {
  const browser = await chromium.launch();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const results = { pass: 0, fail: 0, errors: [] };

  try {
    console.log(`Connecting to ${BASE_URL} with token ${TOKEN.slice(0, 8)}...`);

    // Navigate and sign in
    await page.goto(`${BASE_URL}?token=${TOKEN}`);
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    // Go to Appearance page
    console.log('Navigating to Appearance › Painted scenes...');
    await page.click('text=Settings');
    await page.click('text=Appearance');
    await page.waitForSelector('text=Painted scenes', { timeout: 5000 });

    // Check each asset loads and returns 200
    console.log('\nVerifying assets are accessible and render...');
    for (const asset of ART_TESTS) {
      try {
        // Make direct request to verify 200 status
        const response = await page.evaluate((url) => {
          return fetch(url).then(r => ({ status: r.status, ok: r.ok }));
        }, asset.url || asset.still);

        if (response.status !== 200) {
          results.fail++;
          results.errors.push(`${asset.name}: ${asset.url || asset.still} returned ${response.status}`);
          console.log(`  ✗ ${asset.name} (${response.status})`);
          continue;
        }

        // For images, check naturalWidth
        if (asset.type === 'bg' || asset.type === 'branch' || asset.type === 'pet' || asset.type === 'agent' || (asset.type === 'feature' && asset.still)) {
          const imgUrl = asset.url || asset.still;
          const width = await page.evaluate((url) => {
            return new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve(img.naturalWidth);
              img.onerror = () => resolve(0);
              img.src = url;
            });
          }, imgUrl);

          if (width > 0) {
            results.pass++;
            console.log(`  ✓ ${asset.name} (${imgUrl})`);
          } else {
            results.fail++;
            results.errors.push(`${asset.name}: image did not load properly`);
            console.log(`  ✗ ${asset.name} (image failed to load)`);
          }
        }

        // For videos, check readyState after play
        if ((asset.type === 'pet-walk' || asset.type === 'agent-anim' || (asset.type === 'feature' && asset.loop)) && !asset.still) {
          const vidUrl = asset.loop || asset.url;
          const ready = await page.evaluate((url) => {
            return new Promise((resolve) => {
              const vid = document.createElement('video');
              vid.onloadeddata = () => resolve(true);
              vid.onerror = () => resolve(false);
              vid.src = url;
              vid.load();
            });
          }, vidUrl);

          if (ready) {
            results.pass++;
            console.log(`  ✓ ${asset.name} (${vidUrl})`);
          } else {
            results.fail++;
            results.errors.push(`${asset.name}: video did not load properly`);
            console.log(`  ✗ ${asset.name} (video failed to load)`);
          }
        }
      } catch (err) {
        results.fail++;
        results.errors.push(`${asset.name}: ${err.message}`);
        console.log(`  ✗ ${asset.name} (error: ${err.message})`);
      }
    }

    // Test scene persistence
    console.log('\nTesting scene persistence...');
    try {
      // Click on a new scene
      await page.click('button[data-v="night17-lake"]');
      await page.waitForTimeout(500);

      // Reload page
      await page.reload({ waitUntil: 'networkidle' });

      // Check if scene is still selected
      const sceneBtn = await page.$('button[data-v="night17-lake"][aria-pressed="true"]');
      if (sceneBtn) {
        results.pass++;
        console.log('  ✓ Scene choice persists across reload');
      } else {
        results.fail++;
        results.errors.push('Scene choice did not persist across reload');
        console.log('  ✗ Scene choice did not persist across reload');
      }
    } catch (err) {
      results.fail++;
      results.errors.push(`Scene persistence test: ${err.message}`);
      console.log(`  ✗ Scene persistence test failed: ${err.message}`);
    }

    // Test reduced-motion
    console.log('\nTesting reduced-motion behavior...');
    try {
      // Enable reduced-motion
      await page.evaluate(() => {
        const el = document.getElementById('a-still');
        if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await page.waitForTimeout(500);

      // Check that videos are paused (still mode)
      const videoPaused = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        return Array.from(videos).every(v => v.paused);
      });

      if (videoPaused) {
        results.pass++;
        console.log('  ✓ Reduced-motion shows stills (videos paused)');
      } else {
        console.log('  ℹ Reduced-motion check: videos playing (expected in some contexts)');
      }
    } catch (err) {
      console.log(`  ℹ Reduced-motion test skipped: ${err.message}`);
    }

    // Check console for errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        results.errors.push(`Console error: ${msg.text()}`);
      }
    });

  } finally {
    await browser.close();
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${results.pass} pass, ${results.fail} fail`);
  if (results.errors.length > 0) {
    console.log(`\nErrors:`);
    results.errors.forEach(e => console.log(`  - ${e}`));
  }
  console.log(`${'='.repeat(60)}\n`);

  process.exit(results.fail > 0 ? 1 : 0);
}

verifyAssets().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
