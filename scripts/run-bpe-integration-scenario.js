#!/usr/bin/env node

'use strict';

const {
  runBpeIntegrationScenario
} = require('../src/services/bpe-integration-scenario');

const DEFAULTS = Object.freeze({
  gatewayUrl: process.env.BPE_GATEWAY_URL || 'http://127.0.0.1:4700',
  targetUrl: 'https://www.wikipedia.org/',
  searchQuery: 'Alan Turing',
  timeoutMs: 30_000
});

function printUsage(output = console.log) {
  output(`Usage:
  node scripts/run-bpe-integration-scenario.js [options]

Options:
  --gateway-url <url>         BPE API gateway URL. Default: ${DEFAULTS.gatewayUrl}
  --target-url <url>          URL to navigate within the BPE session. Default: ${DEFAULTS.targetUrl}
  --search-query <text>       Query used in the scenario action plan. Default: "${DEFAULTS.searchQuery}"
  --browser <name>            Browser name passed to BPE session create payload.
  --tenant-id <id>            Tenant id for session create payload.
  --viewport <WxH>            Viewport size, for example 1440x900.
  --headless <true|false>     Session headless mode. Default: true
  --connection-mode <mode>    launch | connect_cdp | launch_persistent (default: launch)
  --cdp-url <url>             CDP endpoint when using connect_cdp.
  --page-strategy <strategy>  new_page | reuse_existing.
  --user-data-dir <path>      Browser user data directory for persistent launches.
  --browser-channel <name>    Browser channel override passed to BPE.
  --timeout-ms <number>       Per-request timeout. Default: ${DEFAULTS.timeoutMs}
  --help                      Show this help.
`);
}

function parseBoolean(value, fallback = true) {
  if (value == null) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseViewport(value) {
  if (typeof value !== 'string' || !value.includes('x')) {
    throw new Error(`Invalid viewport format: ${value}`);
  }
  const [widthText, heightText] = value.toLowerCase().split('x', 2);
  const width = Number.parseInt(widthText, 10);
  const height = Number.parseInt(heightText, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid viewport dimensions: ${value}`);
  }
  return { width, height };
}

function readOptionValue(args, index, flag) {
  const token = args[index];
  const equalsIndex = token.indexOf('=');
  if (equalsIndex !== -1) {
    return { value: token.slice(equalsIndex + 1), nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parseArgs(rawArgs = []) {
  const options = {
    gatewayUrl: DEFAULTS.gatewayUrl,
    targetUrl: DEFAULTS.targetUrl,
    searchQuery: DEFAULTS.searchQuery,
    headless: true,
    timeoutMs: DEFAULTS.timeoutMs,
    connection: {
      mode: 'launch'
    }
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unknown argument: ${token}`);
    }

    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    switch (flag) {
      case '--gateway-url': {
        const read = readOptionValue(rawArgs, index, flag);
        options.gatewayUrl = read.value;
        index = read.nextIndex;
        break;
      }
      case '--target-url': {
        const read = readOptionValue(rawArgs, index, flag);
        options.targetUrl = read.value;
        index = read.nextIndex;
        break;
      }
      case '--search-query': {
        const read = readOptionValue(rawArgs, index, flag);
        options.searchQuery = read.value;
        index = read.nextIndex;
        break;
      }
      case '--browser': {
        const read = readOptionValue(rawArgs, index, flag);
        options.browser = read.value;
        index = read.nextIndex;
        break;
      }
      case '--tenant-id': {
        const read = readOptionValue(rawArgs, index, flag);
        options.tenantId = read.value;
        index = read.nextIndex;
        break;
      }
      case '--viewport': {
        const read = readOptionValue(rawArgs, index, flag);
        options.viewport = parseViewport(read.value);
        index = read.nextIndex;
        break;
      }
      case '--headless': {
        const read = readOptionValue(rawArgs, index, flag);
        options.headless = parseBoolean(read.value, true);
        index = read.nextIndex;
        break;
      }
      case '--connection-mode': {
        const read = readOptionValue(rawArgs, index, flag);
        options.connection.mode = read.value;
        index = read.nextIndex;
        break;
      }
      case '--cdp-url': {
        const read = readOptionValue(rawArgs, index, flag);
        options.connection.cdpUrl = read.value;
        index = read.nextIndex;
        break;
      }
      case '--page-strategy': {
        const read = readOptionValue(rawArgs, index, flag);
        options.connection.pageStrategy = read.value;
        index = read.nextIndex;
        break;
      }
      case '--user-data-dir': {
        const read = readOptionValue(rawArgs, index, flag);
        options.connection.userDataDir = read.value;
        index = read.nextIndex;
        break;
      }
      case '--browser-channel': {
        const read = readOptionValue(rawArgs, index, flag);
        options.connection.browserChannel = read.value;
        index = read.nextIndex;
        break;
      }
      case '--timeout-ms': {
        const read = readOptionValue(rawArgs, index, flag);
        const timeoutMs = Number.parseInt(read.value, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new Error('--timeout-ms must be a positive integer');
        }
        options.timeoutMs = timeoutMs;
        index = read.nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const result = await runBpeIntegrationScenario(args);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
