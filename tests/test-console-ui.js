#!/usr/bin/env node

const assert = require('assert');
const vm = require('vm');

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
  let testServer = null;

  try {
    testServer = await startTestServer();

    const routePage = await fetchText(`${testServer.baseUrl}/console`);
    assert.strictEqual(routePage.status, 200, '/console should be served');
    assert(routePage.text.includes('Live Console'), '/console should render the live console shell');
    assert(routePage.text.includes('/orchestration/terminals'), '/console should use the terminals API');
    assert(routePage.text.includes('/orchestration/runs?kind=discussion'), '/console should use discussion run discovery');
    assert(routePage.text.includes('/orchestration/discussions/'), '/console should load persisted discussion threads');
    assert(routePage.text.includes('/orchestration/rooms'), '/console should use the room discovery API');
    assert(routePage.text.includes('/orchestration/usage/runs/'), '/console should fetch persisted run usage summaries');
    assert(routePage.text.includes('cliagents Root Sessions'), '/console should expose the cliagents root-session panel');
    assert(routePage.text.includes('Agent Wall'), '/console should expose a first-class all-agent wall');
    assert(routePage.text.includes('All visible root agents at once'), '/console should describe the all-agent overview purpose');
    assert(routePage.text.includes('agent-wall-list'), '/console should include the agent wall mount point');
    assert(routePage.text.includes('function renderAgentWall'), '/console should render all visible root agents in one view');
    assert(routePage.text.includes('function getRootChildRollup'), '/console should derive child-session rollups for each root agent');
    assert(routePage.text.includes('function getRootProviderJobCount'), '/console should distinguish provider-internal background jobs from broker children');
    assert(routePage.text.includes('data-agent-wall-root'), '/console should let operators select a root from the agent wall');
    assert(routePage.text.includes('Broker Children'), '/console should label broker-owned child-session counts clearly');
    assert(routePage.text.includes('Provider Jobs'), '/console should show provider-internal background job counts separately');
    assert(routePage.text.includes('Room Detail'), '/console should expose a first-class room detail surface');
    assert(routePage.text.includes('Run Usage'), '/console should expose run usage in discussion detail');
    assert(routePage.text.includes('Latest Turn Usage'), '/console should expose usage for room-backed audit turns');
    assert(routePage.text.includes('Attribution:'), '/console should expose broker attribution in usage summaries');
    assert(routePage.text.includes('Conversation + Artifacts'), '/console should expose room artifact filtering controls');
    assert(routePage.text.includes("const queryParams = new URLSearchParams({"), '/console should build scoped root-session summary queries with URLSearchParams');
    assert(routePage.text.includes("queryParams.set('statusFilter', state.rootStatusFilter)"), '/console should pass the root status filter to the broker when supported');
    assert(routePage.text.includes("const query = `/orchestration/root-sessions?${queryParams.toString()}`"), '/console should request root-session summaries through the composed query');
    assert(routePage.text.includes('/orchestration/root-sessions/${encodeURIComponent(state.selectedRootSessionId)}'), '/console should load root-session detail snapshots');
    assert(routePage.text.includes('/orchestration/session-events?limit=400'), '/console should load recent session events for tree rendering');
    assert(routePage.text.includes('Live roots'), '/console should expose a live-roots filter for operator-focused views');
    assert(routePage.text.includes('Operator State'), '/console should expose operator-facing state labels in the detail view');
    assert(routePage.text.includes('Waiting for input'), '/console should include explicit waiting-for-input language');
    assert(routePage.text.includes('Finished the last step and is ready for the next input.'), '/console should explain when a terminal is back at a prompt');
    assert(routePage.text.includes('sessionRootsArchivedCount'), '/console should track archived root-session count in the client state');
    assert(routePage.text.includes('sessionRootsHiddenDetachedCount'), '/console should track hidden detached worker roots in the client state');
    assert(routePage.text.includes('include-archived-roots'), '/console should expose an archived-root toggle');
    assert(routePage.text.includes('session-root-scope'), '/console should expose a root-session scope selector');
    assert(routePage.text.includes('session-root-filter'), '/console should expose a root-session filter');
    assert(routePage.text.includes('URLSearchParams(window.location.search)'), '/console should restore console state from URL params');
    assert(routePage.text.includes('window.history.replaceState'), '/console should persist console state back into the URL');
    assert(routePage.text.includes("rootStatusFilter: ROOT_FILTER_OPTIONS.has(urlState.get('roots')) ? urlState.get('roots') : 'live'"), '/console should default the root filter to live roots');
    assert(routePage.text.includes('archived hidden'), '/console should surface hidden archived-root counts by default');
    assert(routePage.text.includes('detached worker roots hidden'), '/console should surface hidden detached-worker counts by default');
    assert(routePage.text.includes('No cliagents root sessions match the current filters.'), '/console should explain empty filtered root-session results');
    assert(routePage.text.includes('Reuse Events'), '/console should show reuse counts for root sessions');
    assert(routePage.text.includes('Reused Sessions'), '/console should show reused session counts for root sessions');
    assert(routePage.text.includes('Resume Count'), '/console should show per-session resume counts in the tree detail');
    assert(routePage.text.includes('Reuse reason:'), '/console should expose reuse reasons in the tree detail');
    assert(routePage.text.includes('Root Terminal'), '/console should inline the broker-owned root terminal in the root-session detail view');
    assert(routePage.text.includes("bindTerminalDetailActions(terminalWorkspace.focusedBundle.terminal, 'root-terminal'"), '/console should wire reply and control actions for the focused terminal inside the root workspace');
    assert(routePage.text.includes('fetchTerminalBundleWithPreferences'), '/console should load terminal output through the shared terminal-bundle helper with explicit view preferences');
    assert(routePage.text.includes("mode: outputPreferences.mode"), '/console should request either visible-pane or history output');
    assert(routePage.text.includes("format: outputPreferences.format"), '/console should request plain or ANSI output formats');
    assert(routePage.text.includes('Visible Screen'), '/console should expose a visible-pane toggle for root terminals');
    assert(routePage.text.includes('Scrollback'), '/console should expose a scrollback toggle for root terminals');
    assert(routePage.text.includes('renderAnsiToHtml'), '/console should preserve ANSI styling for rich terminal output');
    assert(routePage.text.includes('width: max-content;'), '/console should preserve terminal column width instead of wrapping provider UIs');
    assert(routePage.text.includes('min-width: 100%;'), '/console should still fill the output pane when the captured terminal is narrower than the viewport');
    assert(routePage.text.includes('overflow-wrap: normal;'), '/console should avoid reflowing terminal box-drawing layouts');
    assert(routePage.text.includes('if (code === 2)'), '/console should recognize ANSI dim/faint styling used by managed roots');
    assert(routePage.text.includes("styleState.dim = true;"), '/console should track ANSI dim/faint state in the browser renderer');
    assert(routePage.text.includes('Reply to Terminal'), '/console should expose terminal reply controls');
    assert(routePage.text.includes('This provider pane is a read-only snapshot.'), '/console should clarify that rendered provider output is not the live input surface');
    assert(routePage.text.includes('This root is attached in read-only mode.'), '/console should explain attached-root read-only behavior in the browser');
    assert(routePage.text.includes('/orchestration/runs/reconcile'), '/console should support stale run reconciliation');
    assert(routePage.text.includes('Destroy Terminal'), '/console should expose terminal termination controls');
    assert(routePage.text.includes('new WebSocket'), '/console should connect to the existing WebSocket endpoint');
    assert(routePage.text.includes('localStorage.getItem'), '/console should persist API key state locally for remote access');
    assert(routePage.text.includes('Authentication required.'), '/console should explain broker auth failures instead of rendering an empty agent wall');
    assert(routePage.text.includes('data/local-api-key'), '/console should point local operators to the generated broker token file');
    assert(routePage.text.includes('renderAuthRequiredState'), '/console should centralize unauthenticated-state rendering');
    assert(routePage.text.includes("urlState.get('login')"), '/console should accept a short-lived local console login token');
    assert(routePage.text.includes('/auth/local-console/exchange'), '/console should exchange local login tokens before polling protected APIs');
    assert(routePage.text.includes('Live process:'), '/console should show whether each terminal has a live backing process');
    assert(routePage.text.includes('renderLiveStatePill'), '/console should render explicit live/not-live badges');
    assert(routePage.text.includes('function getOperatorStateDescriptor'), '/console should centralize operator-state derivation for terminals and roots');
    assert(routePage.text.includes('Root Terminal Workspace'), '/console should expose a root-scoped terminal workspace');
    assert(routePage.text.includes('Child terminals are nested inside this root workspace'), '/console should keep child terminal inspection inside the root workspace');
    assert(routePage.text.includes('data-terminal-workspace-target'), '/console should wire inline root-child terminal switching controls');
    assert(routePage.text.includes('Secondary diagnostic view across every live terminal'), '/console should demote the all-terminals list to a secondary diagnostic view');
    const scriptMatch = routePage.text.match(/<script>([\s\S]*)<\/script>/);
    assert(scriptMatch, '/console should contain inline client logic');
    new vm.Script(scriptMatch[1]);

    const staticPage = await fetchText(`${testServer.baseUrl}/console.html`);
    assert.strictEqual(staticPage.status, 200, '/console.html should be served as a static asset');
    assert(staticPage.text.includes('0.0.0.0'), '/console.html should explain same-network iPad access');

    const dashboardPage = await fetchText(`${testServer.baseUrl}/dashboard`);
    assert.strictEqual(dashboardPage.status, 200, '/dashboard should still be served');
    assert(dashboardPage.text.includes('href="/console"'), 'dashboard should link to the live console');

    const runsPage = await fetchText(`${testServer.baseUrl}/runs`);
    assert.strictEqual(runsPage.status, 200, '/runs should still be served');
    assert(runsPage.text.includes('href="/console"'), 'run inspector should link to the live console');

    console.log('✅ Live console UI routes and navigation are available');
  } finally {
    if (testServer) {
      await stopTestServer(testServer);
    }
  }
}

run().then(() => {
  console.log('\nLive console UI smoke tests passed');
}).catch((error) => {
  console.error('\nLive console UI smoke tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
