'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run, __private } = require('../dist/index.js');

function parseOutputFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const result = {};
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    result[key] = value;
  }

  return result;
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withActionEnv(values, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, oldValue] of previous.entries()) {
      if (oldValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = oldValue;
      }
    }
  }
}

test('parseTagsInput supports csv/newline/json', () => {
  assert.deepEqual(__private.parseTagsInput('smoke, regression'), ['smoke', 'regression']);
  assert.deepEqual(__private.parseTagsInput('smoke\ncritical\nsmoke'), ['smoke', 'critical']);
  assert.deepEqual(__private.parseTagsInput('["smoke", "critical"]'), ['smoke', 'critical']);
});

test('run succeeds and emits outputs for completed successful run', async () => {
  let pollCount = 0;

  await withServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/ci/runs') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        runId: 'run_123',
        testCaseCount: 4,
        statusUrl: 'http://localhost/status-not-used',
        appUrl: 'https://app.certyn.io/app/project/staging/tickets/run_123'
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ci/runs/run_123') {
      pollCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (pollCount === 1) {
        res.end(JSON.stringify({
          runId: 'run_123',
          state: 'in_progress',
          failed: 0,
          blocked: 0,
          pending: 4,
          retryAfterSeconds: 1
        }));
        return;
      }

      res.end(JSON.stringify({
        runId: 'run_123',
        state: 'completed',
        conclusion: 'success',
        total: 4,
        passed: 4,
        failed: 0,
        blocked: 0,
        pending: 0,
        skipped: 0,
        appUrl: 'https://app.certyn.io/app/project/staging/tickets/run_123',
        retryAfterSeconds: 0
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/ci/runs/run_123/cancel') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const outputFile = path.join(os.tmpdir(), `certyn-action-output-${Date.now()}.txt`);
    const summaryFile = path.join(os.tmpdir(), `certyn-action-summary-${Date.now()}.md`);
    fs.writeFileSync(outputFile, '', 'utf8');
    fs.writeFileSync(summaryFile, '', 'utf8');

    await withActionEnv({
      INPUT_API_KEY: 'test-key',
      INPUT_PROJECT_SLUG: 'my-app',
      INPUT_PROCESS_SLUG: 'smoke-suite',
      INPUT_API_URL: baseUrl,
      INPUT_WAIT_FOR_COMPLETION: 'true',
      INPUT_TIMEOUT_SECONDS: '20',
      INPUT_INITIAL_POLL_INTERVAL_SECONDS: '1',
      INPUT_MAX_POLL_INTERVAL_SECONDS: '2',
      INPUT_HTTP_MAX_ATTEMPTS: '2',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_RUN_ID: '100',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_JOB: 'test-job'
    }, async () => {
      await run();
    });

    const outputs = parseOutputFile(outputFile);
    assert.equal(outputs.run_id, 'run_123');
    assert.equal(outputs.state, 'completed');
    assert.equal(outputs.conclusion, 'success');
    assert.equal(outputs.failed, '0');
    assert.equal(outputs.blocked, '0');
    assert.equal(outputs.idempotency_replayed, 'false');
  });
});

test('run fails when blocked is non-zero and fail_on_blocked=true', async () => {
  await withServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/ci/runs') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        runId: 'run_blocked',
        testCaseCount: 2,
        statusUrl: 'http://localhost/status-not-used'
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/ci/runs/run_blocked') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        runId: 'run_blocked',
        state: 'completed',
        conclusion: 'action_required',
        total: 2,
        passed: 1,
        failed: 0,
        blocked: 1,
        pending: 0,
        skipped: 0,
        retryAfterSeconds: 0
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }, async (baseUrl) => {
    const outputFile = path.join(os.tmpdir(), `certyn-action-output-${Date.now()}-blocked.txt`);
    const summaryFile = path.join(os.tmpdir(), `certyn-action-summary-${Date.now()}-blocked.md`);
    fs.writeFileSync(outputFile, '', 'utf8');
    fs.writeFileSync(summaryFile, '', 'utf8');

    await withActionEnv({
      INPUT_API_KEY: 'test-key',
      INPUT_PROJECT_SLUG: 'my-app',
      INPUT_PROCESS_SLUG: 'smoke-suite',
      INPUT_API_URL: baseUrl,
      INPUT_WAIT_FOR_COMPLETION: 'true',
      INPUT_TIMEOUT_SECONDS: '20',
      INPUT_INITIAL_POLL_INTERVAL_SECONDS: '1',
      INPUT_MAX_POLL_INTERVAL_SECONDS: '2',
      INPUT_HTTP_MAX_ATTEMPTS: '2',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile
    }, async () => {
      await assert.rejects(async () => {
        await run();
      }, /action-required/i);
    });
  });
});
