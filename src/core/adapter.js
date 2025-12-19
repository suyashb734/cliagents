/**
 * Base Agent Adapter (re-exports BaseLLMAdapter)
 *
 * For backward compatibility, this file re-exports BaseLLMAdapter.
 * New adapters should import BaseLLMAdapter directly from 'base-llm-adapter.js'.
 */

const BaseLLMAdapter = require('./base-llm-adapter');

module.exports = BaseLLMAdapter;