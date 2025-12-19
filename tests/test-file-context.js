#!/usr/bin/env node
/**
 * Test: File Context in Conversations
 *
 * Verifies that Claude correctly distinguishes between different files
 * when multiple files are read in the same session.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3001';
const TEST_DIR = '/tmp/file-context-test';

async function request(method, endpoint, body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) };
  } catch {
    return { status: response.status, data: text };
  }
}

async function main() {
  console.log('🧪 File Context Test');
  console.log('━'.repeat(50));

  // Check server
  try {
    await request('GET', '/health');
    console.log('✅ Server is running');
  } catch {
    console.error('❌ Server not reachable. Start with: npm start');
    process.exit(1);
  }

  // Create test files
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  const files = [
    { name: 'img1.txt', content: 'This image shows a RED CIRCLE on white background' },
    { name: 'img2.txt', content: 'This image shows a BLUE SQUARE on yellow background' },
    { name: 'img3.txt', content: 'This image shows a GREEN TRIANGLE on black background' }
  ];

  for (const f of files) {
    fs.writeFileSync(path.join(TEST_DIR, f.name), f.content);
  }
  console.log(`✅ Created ${files.length} test files`);

  // Create session
  const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
  const sessionId = session.sessionId;
  console.log(`✅ Created session: ${sessionId}`);

  try {
    // First file
    console.log('\n📸 Reading first file (RED CIRCLE)...');
    const { data: r1 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `Read this file and remember it: ${TEST_DIR}/img1.txt`
    });
    console.log(`   Result: ${r1.result?.substring(0, 100)}...`);

    // Second file
    console.log('\n📸 Reading second file (BLUE SQUARE)...');
    const { data: r2 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `Now read this DIFFERENT file: ${TEST_DIR}/img2.txt. What shape does THIS file describe?`
    });
    console.log(`   Result: ${r2.result?.substring(0, 100)}...`);
    const secondCorrect = r2.result?.toLowerCase().includes('blue') ||
                          r2.result?.toLowerCase().includes('square');

    // Third file
    console.log('\n📸 Reading third file (GREEN TRIANGLE)...');
    const { data: r3 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `Now read this NEW file: ${TEST_DIR}/img3.txt. What shape does THIS file describe?`
    });
    console.log(`   Result: ${r3.result?.substring(0, 100)}...`);
    const thirdCorrect = r3.result?.toLowerCase().includes('green') ||
                         r3.result?.toLowerCase().includes('triangle');

    // Recall all
    console.log('\n🔍 Asking to recall all three files...');
    const { data: r4 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `List what shape each file contained: img1.txt=?, img2.txt=?, img3.txt=?`
    });
    console.log(`   Result: ${r4.result?.substring(0, 300)}...`);

    // Summary
    console.log('\n' + '━'.repeat(50));
    console.log('📊 Results:');
    console.log(`   Second file identified correctly: ${secondCorrect ? '✅' : '❌'}`);
    console.log(`   Third file identified correctly: ${thirdCorrect ? '✅' : '❌'}`);

    if (secondCorrect && thirdCorrect) {
      console.log('\n✅ PASS: Claude correctly distinguishes between files in the same session!');
    } else {
      console.log('\n❌ FAIL: Claude may be confusing files.');
    }

  } finally {
    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
    console.log('\n🧹 Session cleaned up');

    for (const f of files) {
      fs.unlinkSync(path.join(TEST_DIR, f.name));
    }
    fs.rmdirSync(TEST_DIR);
    console.log('🧹 Test files cleaned up');
  }
}

main().catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});
