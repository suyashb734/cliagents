const { PermissionManager } = require('../src/permissions/permission-manager');
const path = require('path');
const assert = require('assert');

// Mock process.cwd to be consistent
const CWD = process.cwd();
const ALLOWED_DIR = path.join(CWD, 'allowed');
const DENIED_FILE = path.join(CWD, 'denied_secret.txt');
const EVIL_PATH = path.join(CWD, 'allowed-evil'); // Prefix match attack

const pm = new PermissionManager({
  allowedTools: null,
  allowedPaths: [ALLOWED_DIR],
  deniedPaths: [DENIED_FILE]
});

async function test(name, checkFn) {
  try {
    await checkFn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('Running Security Fix Verification...');

  // 1. Test Path Prefix Bypass
  await test('Path Prefix Bypass', async () => {
    // Should allow exact match or subdirectory
    const res1 = await pm.checkPermission('Read', { path: path.join(ALLOWED_DIR, 'file.txt') });
    assert.strictEqual(res1.allowed, true, 'Should allow file in allowed dir');

    // Should deny prefix match that is not a subdirectory
    const res2 = await pm.checkPermission('Read', { path: EVIL_PATH });
    assert.strictEqual(res2.allowed, false, 'Should deny prefix match');
  });

  // 2. Test Command Chaining
  await test('Command Chaining', async () => {
    // Safe command ; Restricted file access
    const cmd = `echo hello ; cat ${DENIED_FILE}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, false, 'Should detect denied file in chained command');
  });

  // 3. Test Piping
  await test('Piping', async () => {
    // Safe command | Restricted file access (e.g. grep on denied file)
    // Note: grep takes file argument
    const cmd = `cat safe.txt | grep pattern ${DENIED_FILE}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, false, 'Should detect denied file in pipe');
  });

  // 4. Test Redirection (Append)
  await test('Redirection >>', async () => {
    const cmd = `echo "hacked" >> ${DENIED_FILE}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, false, 'Should detect denied file in append redirection');
  });

  // 5. Test Redirection (2>)
  await test('Redirection 2>', async () => {
    const cmd = `ls -l 2> ${DENIED_FILE}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, false, 'Should detect denied file in stderr redirection');
  });

  // 6. Test Unrestricted Command List
  await test('Unrestricted Command', async () => {
    // python is not in the old restricted list, but accesses denied file
    const cmd = `python ${DENIED_FILE}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, false, 'Should detect denied file in unrestricted command');
  });

  // 7. Test Allowed Command
  await test('Allowed Command', async () => {
    const cmd = `ls -la ${ALLOWED_DIR}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, true, 'Should allow command with allowed path');
  });
  
  // 8. Test Pipe Chaining with Redirection
  await test('Complex Chain', async () => {
    const cmd = `cd ${ALLOWED_DIR} && ls | grep foo > ${DENIED_FILE}`;
    const res = await pm.checkPermission('Bash', { command: cmd });
    assert.strictEqual(res.allowed, false, 'Should detect denied file in complex chain');
  });

}

runTests();
