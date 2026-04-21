#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { ModelRoutingService } = require('../src/services/model-routing');

function run() {
  const service = new ModelRoutingService();

  const recommendation = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'implement',
    availableModels: [
      { id: 'openrouter/qwen/qwen3.6-plus' },
      { id: 'opencode-go/qwen3.6-plus' },
      { id: 'minimax-coding-plan/MiniMax-M2.7' }
    ]
  });

  assert.strictEqual(recommendation.selectedModel, 'minimax-coding-plan/MiniMax-M2.7');
  assert.strictEqual(recommendation.selectedFamily, 'minimax');
  assert.strictEqual(recommendation.selectedProvider, 'minimax-coding-plan');

  const reviewRecommendation = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels: [
      { id: 'openrouter/qwen/qwen3.6-plus' },
      { id: 'opencode-go/minimax-m2.7' }
    ]
  });

  assert.strictEqual(reviewRecommendation.selectedModel, 'openrouter/qwen/qwen3.6-plus');
  assert.strictEqual(reviewRecommendation.selectedFamily, 'qwen');

  const reviewQwenProviderOrder = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels: [
      { id: 'opencode-go/qwen3.6-plus' },
      { id: 'openrouter/qwen/qwen3.6-plus' }
    ]
  });

  assert.strictEqual(reviewQwenProviderOrder.selectedModel, 'openrouter/qwen/qwen3.6-plus');
  assert.strictEqual(reviewQwenProviderOrder.selectedProvider, 'openrouter');

  const noPolicy = service.recommendModel({
    adapter: 'codex-cli',
    role: 'implement',
    availableModels: [{ id: 'o4-mini' }]
  });

  assert.strictEqual(noPolicy.selectedModel, null);
  assert.strictEqual(noPolicy.strategy, 'no-policy');

  // 1) implement role still preferring minimax when available
  const implMinimax = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'implement',
    availableModels: [
      { id: 'minimax-coding-plan/MiniMax-M2.7' },
      { id: 'openrouter/zhipuai/glm-4.0-flash' }
    ]
  });
  assert.strictEqual(implMinimax.selectedFamily, 'minimax');
  assert.strictEqual(implMinimax.selectedModel, 'minimax-coding-plan/MiniMax-M2.7');

  // 2) review role preferring qwen when healthy/available
  const reviewQwen = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels: [
      { id: 'openrouter/zhipuai/glm-4.0-flash' },
      { id: 'openrouter/qwen/qwen3.6-plus' }
    ]
  });
  assert.strictEqual(reviewQwen.selectedFamily, 'qwen');
  assert.strictEqual(reviewQwen.selectedModel, 'openrouter/qwen/qwen3.6-plus');

  // 3) fallback to glm when qwen candidates are unavailable
  //    GLM family prefers opencode-go/glm-5.1 > opencode-go/glm-5 > openrouter glm
  const reviewGlmFallback = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels: [
      { id: 'opencode-go/glm-5.1' }
    ]
  });
  assert.strictEqual(reviewGlmFallback.selectedFamily, 'glm');
  assert.strictEqual(reviewGlmFallback.selectedModel, 'opencode-go/glm-5.1');

  // 3b) GLM also used when qwen models are present but excluded by degraded-model metadata.
  //    degradedModels is an optional array field on each available model object.
  //    When a model carries a degraded-model entry that matches a qwen provider name,
  //    that model is treated as unavailable for qwen-family lookups.
  //    Expected shape: availableModels items may include:
  //      { id: "...", name: "...", degradedModels: ["opencode-go", "openrouter"] }
  //    where the strings name providers that are degraded for this model.
  const reviewGlmDegraded = service.recommendModel({
    adapter: 'opencode-cli',
    role: 'review',
    availableModels: [
      {
        id: 'opencode-go/glm-5.1'
      },
      {
        id: 'openrouter/qwen/qwen3.6-plus',
        degradedModels: ['openrouter']
      }
    ]
  });
  assert.strictEqual(reviewGlmDegraded.selectedFamily, 'glm');
  assert.strictEqual(reviewGlmDegraded.selectedModel, 'opencode-go/glm-5.1');

  // 4) no regression for no-policy adapters
  const noPolicyRegression = service.recommendModel({
    adapter: 'some-unknown-adapter',
    role: 'implement',
    availableModels: [{ id: 'o4-mini' }]
  });
  assert.strictEqual(noPolicyRegression.selectedModel, null);
  assert.strictEqual(noPolicyRegression.strategy, 'no-policy');

  console.log('✅ Model routing service recommends config-ranked models correctly');
  console.log('✅ implement role prefers minimax when available');
  console.log('✅ review role prefers qwen when healthy/available');
  console.log('✅ qwen routing prefers OpenRouter before opencode-go');
  console.log('✅ glm fallback when qwen unavailable');
  console.log('✅ glm fallback when qwen excluded by degraded-model metadata');
  console.log('✅ no-policy adapters still return null/no-policy');
}

try {
  run();
} catch (error) {
  console.error('Model routing service tests failed');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
