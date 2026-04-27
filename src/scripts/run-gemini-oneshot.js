#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const GeminiCliAdapter = require('../adapters/gemini-cli');

const {
  inferGeminiBrokerDefaultModel,
  parseGeminiFallbackModels,
  isGeminiCapacityErrorMessage
} = GeminiCliAdapter;

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function buildModelOrder(requestedModel) {
  const candidates = [];

  if (requestedModel && requestedModel !== 'default') {
    candidates.push(requestedModel);
  } else if (process.env.CLIAGENTS_GEMINI_MODEL) {
    candidates.push(process.env.CLIAGENTS_GEMINI_MODEL);
  } else {
    candidates.push(null);
  }

  const brokerDefault = inferGeminiBrokerDefaultModel();
  if (brokerDefault) {
    candidates.push(brokerDefault);
  }

  candidates.push(...parseGeminiFallbackModels());

  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate == null ? '__provider_default__' : String(candidate).trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate == null ? null : String(candidate).trim());
  }
  return deduped;
}

function hasGeminiSuccessSignal(stdout) {
  const text = String(stdout || '');
  if (!text.trim()) {
    return false;
  }

  if (/"type"\s*:\s*"result"[\s\S]*"status"\s*:\s*"success"/.test(text)) {
    return true;
  }

  if (/"type"\s*:\s*"message"[\s\S]*"role"\s*:\s*"assistant"/.test(text)) {
    return true;
  }

  return false;
}

function runAttempt(geminiPath, args, workDir, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(geminiPath, args, {
      cwd: workDir,
      env: {
        ...process.env,
        NO_COLOR: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      spawnError = error;
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        code: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
        timedOut,
        spawnError
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const message = String(args.message || '');
  const workDir = args.workdir ? path.resolve(args.workdir) : process.cwd();
  const requestedModel = args.model ? String(args.model) : null;
  const requestedSessionId = args['session-id'] ? String(args['session-id']) : null;
  const timeoutMs = Number(args.timeout || 180000);

  if (!message) {
    throw new Error('Missing required --message');
  }

  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  const adapter = new GeminiCliAdapter({
    model: requestedModel || undefined
  });
  const geminiPath = adapter._getGeminiPath();
  const models = buildModelOrder(requestedModel);
  // Best-effort snapshot for detecting the session created by this run. Other Gemini
  // processes in the same workDir can still create sessions during this window.
  const sessionsBefore = requestedSessionId
    ? []
    : await adapter._listGeminiSessions(workDir, {
        timeoutMs: Math.min(timeoutMs, 10000)
      });
  const resumeRef = requestedSessionId
    ? await adapter._resolveGeminiResumeRef({
      geminiSessionId: requestedSessionId,
      workDir
    }, {
      timeoutMs: Math.min(timeoutMs, 15000),
      pollIntervalMs: 500
    })
    : null;

  if (models.length === 0) {
    throw new Error('No Gemini models available for one-shot execution');
  }
  if (requestedSessionId && !resumeRef) {
    throw new Error(`Gemini session ${requestedSessionId} could not be resolved for ${workDir}`);
  }

  let lastAttempt = null;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const geminiArgs = ['--approval-mode', 'yolo'];
    if (model) {
      geminiArgs.push('-m', model);
    }
    if (resumeRef) {
      geminiArgs.push('-r', resumeRef);
    }
    geminiArgs.push('-p', message, '-o', 'stream-json');

    process.stderr.write(
      `[cliagents] Gemini one-shot attempt ${index + 1}/${models.length}: ` +
      `gemini ${geminiArgs.join(' ')}\n`
    );

    const attempt = await runAttempt(geminiPath, geminiArgs, workDir, timeoutMs);
    lastAttempt = attempt;

    const combinedOutput = [attempt.stdout, attempt.stderr, attempt.spawnError?.message]
      .filter(Boolean)
      .join('\n');
    const successfulResponse = hasGeminiSuccessSignal(attempt.stdout);

    if (attempt.code === 0 && successfulResponse) {
      const sessionId = requestedSessionId || await adapter._detectNewGeminiSessionId(workDir, sessionsBefore, {
        timeoutMs: Math.min(timeoutMs, 12000),
        pollIntervalMs: 500
      });
      if (sessionId) {
        process.stderr.write(`__CLIAGENTS_PROVIDER_SESSION__${sessionId}\n`);
      }
      if (attempt.stdout) {
        process.stdout.write(attempt.stdout);
      }
      if (attempt.stderr) {
        process.stderr.write(attempt.stderr);
      }
      return;
    }

    if (!attempt.timedOut && isGeminiCapacityErrorMessage(combinedOutput) && index < models.length - 1) {
      process.stderr.write(`[cliagents] Gemini capacity on ${model || 'provider-default'}; trying ${models[index + 1] || 'provider-default'}\n`);
      continue;
    }

    if (attempt.code === 0 && !successfulResponse && index < models.length - 1) {
      process.stderr.write(`[cliagents] Gemini attempt on ${model || 'provider-default'} exited 0 without a success result; trying ${models[index + 1] || 'provider-default'}\n`);
      continue;
    }

    break;
  }

  if (lastAttempt?.stdout) {
    process.stdout.write(lastAttempt.stdout);
  }
  if (lastAttempt?.stderr) {
    process.stderr.write(lastAttempt.stderr);
  }
  if (lastAttempt?.spawnError) {
    process.stderr.write(`${lastAttempt.spawnError.message}\n`);
  }

  process.exit(lastAttempt?.code || 1);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
