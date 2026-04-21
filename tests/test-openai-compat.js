#!/usr/bin/env node

'use strict';

const assert = require('assert');

const { translateOpenAIRequest } = require('../src/server/openai-compat');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
  }
}

console.log('OpenAI compatibility translation tests\n');

test('translateOpenAIRequest rejects null content entries', () => {
  assert.throws(
    () => translateOpenAIRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: null }]
    }),
    /role and content fields/
  );
});

test('translateOpenAIRequest rejects undefined content entries', () => {
  assert.throws(
    () => translateOpenAIRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: undefined }]
    }),
    /role and content fields/
  );
});

if (failed > 0) {
  process.exit(1);
}

console.log(`\n${passed} passed, 0 failed`);
