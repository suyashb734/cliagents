#!/usr/bin/env node
/**
 * Test: Screenshot Context in Conversations
 *
 * Verifies that Claude correctly identifies different images
 * when multiple screenshots are shown in the same session.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3001';
const TEST_DIR = '/tmp/screenshot-test';

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

// Create simple test images with different colors/text
async function createTestImages() {
  // Ensure directory exists
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  // We'll create simple text files that describe what the "image" would show
  // Since we can't easily create PNGs, we'll test with text descriptions

  const images = [
    { name: 'screenshot-1.txt', content: 'RED CIRCLE on white background' },
    { name: 'screenshot-2.txt', content: 'BLUE SQUARE on yellow background' },
    { name: 'screenshot-3.txt', content: 'GREEN TRIANGLE on black background' }
  ];

  for (const img of images) {
    fs.writeFileSync(path.join(TEST_DIR, img.name), img.content);
  }

  return images.map(img => path.join(TEST_DIR, img.name));
}

async function main() {
  console.log('🧪 Screenshot Context Test');
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
  const testFiles = await createTestImages();
  console.log(`✅ Created ${testFiles.length} test files`);

  // Create a session
  const { data: session } = await request('POST', '/sessions', { adapter: 'claude-code' });
  const sessionId = session.sessionId;
  console.log(`✅ Created session: ${sessionId}`);

  try {
    // Message 1: Show first "screenshot"
    console.log('\n📸 Showing first file (RED CIRCLE)...');
    const { data: response1 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `Read this file and remember what it describes: ${testFiles[0]}`
    });
    console.log(`   Response: ${response1.result?.substring(0, 100)}...`);

    // Message 2: Show second "screenshot"
    console.log('\n📸 Showing second file (BLUE SQUARE)...');
    const { data: response2 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `Now read this DIFFERENT file: ${testFiles[1]}. What does THIS file describe?`
    });
    console.log(`   Response: ${response2.result?.substring(0, 100)}...`);

    // Check if it correctly identifies the SECOND file
    const secondCorrect = response2.result?.toLowerCase().includes('blue') ||
                          response2.result?.toLowerCase().includes('square');

    // Message 3: Show third "screenshot"
    console.log('\n📸 Showing third file (GREEN TRIANGLE)...');
    const { data: response3 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `Now read this NEW file: ${testFiles[2]}. What does THIS specific file contain? Don't describe previous files.`
    });
    console.log(`   Response: ${response3.result?.substring(0, 100)}...`);

    // Check if it correctly identifies the THIRD file
    const thirdCorrect = response3.result?.toLowerCase().includes('green') ||
                         response3.result?.toLowerCase().includes('triangle');

    // Message 4: Ask about ALL files to verify it distinguishes them
    console.log('\n🔍 Asking to distinguish all three files...');
    const { data: response4 } = await request('POST', `/sessions/${sessionId}/messages`, {
      message: `You've seen 3 files. List what each one contained:
      1. ${testFiles[0]} = ?
      2. ${testFiles[1]} = ?
      3. ${testFiles[2]} = ?`
    });
    console.log(`   Response: ${response4.result?.substring(0, 300)}...`);

    // Summary
    console.log('\n' + '━'.repeat(50));
    console.log('📊 Results:');
    console.log(`   Second file identified correctly: ${secondCorrect ? '✅' : '❌'}`);
    console.log(`   Third file identified correctly: ${thirdCorrect ? '✅' : '❌'}`);

    if (secondCorrect && thirdCorrect) {
      console.log('\n✅ Claude correctly distinguishes between files in the same session!');
    } else {
      console.log('\n⚠️  Claude may be confusing files. Check the responses above.');
    }

  } finally {
    // Cleanup
    await request('DELETE', `/sessions/${sessionId}`);
    console.log('\n🧹 Session cleaned up');

    // Remove test files
    for (const file of testFiles) {
      fs.unlinkSync(file);
    }
    fs.rmdirSync(TEST_DIR);
    console.log('🧹 Test files cleaned up');
  }
}

main().catch(error => {
  console.error('Test error:', error);
  process.exit(1);
});
