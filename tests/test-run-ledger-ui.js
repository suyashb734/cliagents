#!/usr/bin/env node

const assert = require('assert');

const { startTestServer, stopTestServer } = require('./helpers/server-harness');

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  return {
    status: response.status,
    text
  };
}

async function run() {
  const previousReadFlag = process.env.RUN_LEDGER_READS_ENABLED;
  process.env.RUN_LEDGER_READS_ENABLED = '1';

  let testServer = null;

  try {
    testServer = await startTestServer();

    const routePage = await fetchText(`${testServer.baseUrl}/runs`);
    assert.strictEqual(routePage.status, 200, '/runs should be served');
    assert(routePage.text.includes('Run Inspector'), '/runs should render the run inspector shell');
    assert(routePage.text.includes('/orchestration/runs'), '/runs should point at the run-ledger API');
    assert(routePage.text.includes('discussion, plan-review'), '/runs should mention discussion runs in the inspector copy');
    assert(routePage.text.includes('Participant Comparison'), '/runs should expose the comparison view');
    assert(routePage.text.includes('Discussion Rounds'), '/runs should expose discussion-specific rendering');
    assert(routePage.text.includes('Run Inputs'), '/runs should expose run-level input visibility');
    assert(routePage.text.includes('What This Participant Saw'), '/runs should expose participant prompt visibility');
    assert(routePage.text.includes('Previous'), '/runs should expose pagination controls');
    assert(routePage.text.includes('window.history.replaceState'), '/runs should persist filter and selection state in the URL');

    const staticPage = await fetchText(`${testServer.baseUrl}/runs.html`);
    assert.strictEqual(staticPage.status, 200, '/runs.html should be served as a static asset');
    assert(staticPage.text.includes('RUN_LEDGER_READS_ENABLED=1'), '/runs.html should explain the feature flag requirement');

    const dashboardPage = await fetchText(`${testServer.baseUrl}/dashboard`);
    assert.strictEqual(dashboardPage.status, 200, '/dashboard should still be served');
    assert(dashboardPage.text.includes('href="/runs"'), 'dashboard should link to the run inspector');

    console.log('✅ Run inspector UI routes and links are available');
  } finally {
    if (testServer) {
      await stopTestServer(testServer);
    }

    if (previousReadFlag === undefined) {
      delete process.env.RUN_LEDGER_READS_ENABLED;
    } else {
      process.env.RUN_LEDGER_READS_ENABLED = previousReadFlag;
    }
  }
}

run().then(() => {
  console.log('\nRun-ledger UI smoke tests passed');
}).catch((error) => {
  console.error('\nRun-ledger UI smoke tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
