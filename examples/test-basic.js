/**
 * Basic test example for cliagents
 *
 * Tests both programmatic and HTTP API usage.
 */

const { createSessionManager, AgentServer } = require('../src');

async function testProgrammatic() {
  console.log('=== Testing Programmatic Usage ===\n');

  const manager = createSessionManager();

  // Check if Claude Code is available
  const available = await manager.checkAdapterAvailability('claude-code');
  console.log('Claude Code available:', available);

  if (!available) {
    console.log('Claude Code CLI not found. Skipping programmatic test.');
    return;
  }

  // Create a session
  console.log('\nCreating session...');
  const session = await manager.createSession({
    adapter: 'claude-code',
    workDir: '/tmp/agent-test'
  });
  console.log('Session created:', session.sessionId);

  // Send a simple message
  console.log('\nSending message...');
  const response = await manager.send(session.sessionId, 'What is 2 + 2? Reply with just the number.');
  console.log('Response:', response.text.substring(0, 200));

  // Terminate session
  console.log('\nTerminating session...');
  await manager.terminateSession(session.sessionId);
  console.log('Session terminated');

  // Cleanup
  await manager.shutdown();
  console.log('\nProgrammatic test complete!\n');
}

async function testHTTPAPI() {
  console.log('=== Testing HTTP API ===\n');

  const server = new AgentServer({ port: 3099 });
  await server.start();

  try {
    // Health check
    const healthRes = await fetch('http://localhost:3099/health');
    const health = await healthRes.json();
    console.log('Health:', health);

    // List adapters
    const adaptersRes = await fetch('http://localhost:3099/adapters');
    const adapters = await adaptersRes.json();
    console.log('Adapters:', adapters);

    // One-shot ask
    console.log('\nSending one-shot ask...');
    const askRes = await fetch('http://localhost:3099/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What is the capital of France? Reply with just the city name.',
        timeout: 30000
      })
    });
    const askResult = await askRes.json();
    console.log('Ask result:', askResult.text?.substring(0, 200) || askResult);

  } catch (error) {
    console.error('HTTP test error:', error.message);
  }

  await server.stop();
  console.log('\nHTTP API test complete!\n');
}

async function main() {
  console.log('cliagents - Basic Tests\n');
  console.log('====================================\n');

  await testProgrammatic();
  await testHTTPAPI();

  console.log('All tests complete!');
}

main().catch(console.error);
