#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

const TERMINAL_STATES = new Set(['completed', 'cancelled']);
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function logInfo(message) {
  console.log(`[certyn/action] ${message}`);
}

function logWarn(message) {
  console.warn(`[certyn/action] ${message}`);
}

function appendEnvFile(file, line) {
  if (!file) {
    return;
  }

  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

function setOutput(name, value) {
  const normalized = value === undefined || value === null ? '' : String(value);
  if (process.env.GITHUB_OUTPUT) {
    appendEnvFile(process.env.GITHUB_OUTPUT, `${name}=${normalized}`);
    return;
  }

  // Fallback for local runs.
  process.stdout.write(`::set-output name=${name}::${normalized}\n`);
}

function appendSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  appendEnvFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}

function getInputKey(name) {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

function getRawInput(name) {
  const key = getInputKey(name);
  return process.env[key] ?? '';
}

function getStringInput(name, options = {}) {
  const { required = false, defaultValue = '' } = options;
  const value = getRawInput(name).trim();
  if (value) {
    return value;
  }

  if (required) {
    throw new Error(`Input '${name}' is required.`);
  }

  return defaultValue;
}

function parseBoolean(value, defaultValue) {
  if (value === '' || value === undefined || value === null) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value '${value}'.`);
}

function getBooleanInput(name, defaultValue) {
  return parseBoolean(getRawInput(name), defaultValue);
}

function toPositiveInt(raw, fieldName, defaultValue) {
  const value = raw === '' ? defaultValue : Number(raw);
  if (!Number.isFinite(value) || Number.isInteger(value) === false || value <= 0) {
    throw new Error(`Input '${fieldName}' must be a positive integer.`);
  }

  return value;
}

function getIntInput(name, defaultValue) {
  return toPositiveInt(getRawInput(name), name, defaultValue);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeApiUrl(raw) {
  const normalized = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`Input 'api_url' must start with http:// or https://. Received '${raw}'.`);
  }

  return normalized;
}

function parseTagsInput(rawTags) {
  if (!rawTags || !rawTags.trim()) {
    return [];
  }

  const raw = rawTags.trim();

  if (raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Input 'tags' looks like JSON but is invalid: ${raw}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error("Input 'tags' JSON must be an array of strings.");
    }

    return [...new Set(parsed.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  }

  const parts = raw
    .split(/[\n,]/g)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(parts)];
}

function inferExternalUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!serverUrl || !repository || !runId) {
    return '';
  }

  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function inferIdempotencyKey() {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) {
    return '';
  }

  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const job = process.env.GITHUB_JOB || 'job';
  return `${runId}-${runAttempt}-${job}`;
}

function extractErrorMessage(response) {
  if (response.json && typeof response.json === 'object') {
    const fromError = typeof response.json.error === 'string' ? response.json.error : '';
    if (fromError) {
      return fromError;
    }

    const fromMessage = typeof response.json.message === 'string' ? response.json.message : '';
    if (fromMessage) {
      return fromMessage;
    }
  }

  return response.text ? response.text.slice(0, 500) : `HTTP ${response.status}`;
}

function getRetryDelayMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.floor(seconds * 1000);
    }
  }

  const cappedAttempt = Math.min(attempt, 6);
  const base = 500 * (2 ** (cappedAttempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(base + jitter, 15_000);
}

async function requestJson(url, options) {
  const {
    method,
    headers,
    body,
    maxAttempts,
    requestTimeoutMs,
    retryLabel
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeout);

      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      const result = {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        json,
        text
      };

      if (!response.ok && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
        const retryMs = getRetryDelayMs(attempt, response.headers.get('retry-after'));
        logWarn(`${retryLabel}: attempt ${attempt}/${maxAttempts} returned ${response.status}, retrying in ${retryMs}ms.`);
        await sleep(retryMs);
        continue;
      }

      return result;
    } catch (error) {
      clearTimeout(timeout);

      if (attempt < maxAttempts) {
        const retryMs = getRetryDelayMs(attempt, null);
        logWarn(`${retryLabel}: attempt ${attempt}/${maxAttempts} failed (${error.message}), retrying in ${retryMs}ms.`);
        await sleep(retryMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`${retryLabel}: exhausted retries.`);
}

function parseCounter(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function evaluateVerdict(state, status, config) {
  if (state === 'cancelled' && config.failOnCancelled) {
    return { ok: false, reason: 'Certyn run was cancelled.' };
  }

  const failed = parseCounter(status.failed);
  const blocked = parseCounter(status.blocked);

  if (config.failOnFailed && failed > 0) {
    return { ok: false, reason: `Certyn run failed (${failed} failed).` };
  }

  if (config.failOnBlocked && blocked > 0) {
    return { ok: false, reason: `Certyn run is action-required (${blocked} blocked).` };
  }

  return { ok: true, reason: '' };
}

function buildSummary(runId, statusUrl, status, verdict) {
  const appUrl = status.appUrl || '';
  const lines = [
    '## Certyn CI Run',
    '',
    `- Run ID: \`${runId}\``,
    `- State: \`${status.state || ''}\``,
    `- Conclusion: \`${status.conclusion || ''}\``,
    `- Status URL: ${statusUrl}`,
    appUrl ? `- App URL: ${appUrl}` : '- App URL: (not provided)',
    '',
    '| total | passed | failed | blocked | pending | skipped |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${parseCounter(status.total)} | ${parseCounter(status.passed)} | ${parseCounter(status.failed)} | ${parseCounter(status.blocked)} | ${parseCounter(status.pending)} | ${parseCounter(status.skipped)} |`
  ];

  if (!verdict.ok) {
    lines.push('', `**Result:** ${verdict.reason}`);
  }

  return lines;
}

function setStatusOutputs(status) {
  setOutput('state', status.state || '');
  setOutput('conclusion', status.conclusion || '');
  setOutput('total', parseCounter(status.total));
  setOutput('passed', parseCounter(status.passed));
  setOutput('failed', parseCounter(status.failed));
  setOutput('blocked', parseCounter(status.blocked));
  setOutput('pending', parseCounter(status.pending));
  setOutput('skipped', parseCounter(status.skipped));

  if (status.appUrl) {
    setOutput('app_url', status.appUrl);
  }
}

async function cancelRun(config, headers, runId, reason) {
  const cancelUrl = `${config.apiUrl}/api/ci/runs/${encodeURIComponent(runId)}/cancel`;
  const response = await requestJson(cancelUrl, {
    method: 'POST',
    headers,
    body: reason ? { reason } : undefined,
    maxAttempts: config.httpMaxAttempts,
    requestTimeoutMs: config.requestTimeoutMs,
    retryLabel: 'cancel run'
  });

  if (!response.ok) {
    logWarn(`Cancel request failed with status ${response.status}: ${extractErrorMessage(response)}`);
    return false;
  }

  logInfo(`Cancel request accepted for run ${runId}.`);
  return true;
}

function registerSignalHandlers(context) {
  async function onSignal(signal) {
    logWarn(`Received ${signal}.`);

    if (!context.cancelOnJobCancel || !context.runId || context.cancellationInProgress) {
      process.exit(1);
      return;
    }

    context.cancellationInProgress = true;
    try {
      await cancelRun(context.config, context.headers, context.runId, context.cancelReason);
    } catch (error) {
      logWarn(`Failed to cancel run during ${signal}: ${error.message}`);
    }

    process.exit(1);
  }

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

function readConfig() {
  const config = {
    apiKey: getStringInput('api_key', { required: true }),
    projectSlug: getStringInput('project_slug', { required: true }),
    environmentKey: getStringInput('environment_key', { defaultValue: '' }),
    processSlug: getStringInput('process_slug', { defaultValue: '' }),
    tags: parseTagsInput(getStringInput('tags', { defaultValue: '' })),
    apiUrl: normalizeApiUrl(getStringInput('api_url', { defaultValue: 'https://api.certyn.io' })),
    repository: getStringInput('repository', { defaultValue: process.env.GITHUB_REPOSITORY || '' }),
    ref: getStringInput('ref', { defaultValue: process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || '' }),
    commitSha: getStringInput('commit_sha', { defaultValue: process.env.GITHUB_SHA || '' }),
    event: getStringInput('event', { defaultValue: process.env.GITHUB_EVENT_NAME || '' }),
    externalUrl: getStringInput('external_url', { defaultValue: inferExternalUrl() }),
    idempotencyKey: getStringInput('idempotency_key', { defaultValue: inferIdempotencyKey() }),
    waitForCompletion: getBooleanInput('wait_for_completion', true),
    timeoutSeconds: getIntInput('timeout_seconds', 1800),
    initialPollIntervalSeconds: getIntInput('initial_poll_interval_seconds', 10),
    maxPollIntervalSeconds: getIntInput('max_poll_interval_seconds', 30),
    failOnFailed: getBooleanInput('fail_on_failed', true),
    failOnBlocked: getBooleanInput('fail_on_blocked', true),
    failOnCancelled: getBooleanInput('fail_on_cancelled', true),
    cancelOnTimeout: getBooleanInput('cancel_on_timeout', true),
    cancelOnJobCancel: getBooleanInput('cancel_on_job_cancel', true),
    cancelReason: getStringInput('cancel_reason', { defaultValue: 'Cancelled by certyn/action' }),
    requestTimeoutMs: getIntInput('request_timeout_seconds', 30) * 1000,
    httpMaxAttempts: getIntInput('http_max_attempts', 4)
  };

  if ((config.processSlug ? 1 : 0) + (config.tags.length > 0 ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of 'process_slug' or 'tags'.");
  }

  if (config.initialPollIntervalSeconds > config.maxPollIntervalSeconds) {
    throw new Error("'initial_poll_interval_seconds' cannot be greater than 'max_poll_interval_seconds'.");
  }

  return config;
}

function buildCreatePayload(config) {
  const payload = {
    projectSlug: config.projectSlug
  };

  if (config.environmentKey) {
    payload.environmentKey = config.environmentKey;
  }

  if (config.processSlug) {
    payload.processSlug = config.processSlug;
  }

  if (config.tags.length > 0) {
    payload.tags = config.tags;
  }

  if (config.repository) {
    payload.repository = config.repository;
  }

  if (config.ref) {
    payload.ref = config.ref;
  }

  if (config.commitSha) {
    payload.commitSha = config.commitSha;
  }

  if (config.event) {
    payload.event = config.event;
  }

  if (config.externalUrl) {
    payload.externalUrl = config.externalUrl;
  }

  return payload;
}

function buildHeaders(config) {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': config.apiKey,
    'User-Agent': 'certyn/action@v1'
  };

  if (config.idempotencyKey) {
    headers['Idempotency-Key'] = config.idempotencyKey;
  }

  return headers;
}

async function run() {
  const config = readConfig();
  const headers = buildHeaders(config);
  const createPayload = buildCreatePayload(config);

  logInfo(`Creating run for project '${config.projectSlug}' on ${config.apiUrl}.`);
  const createResponse = await requestJson(`${config.apiUrl}/api/ci/runs`, {
    method: 'POST',
    headers,
    body: createPayload,
    maxAttempts: config.httpMaxAttempts,
    requestTimeoutMs: config.requestTimeoutMs,
    retryLabel: 'create run'
  });

  if (!createResponse.ok) {
    throw new Error(`Create run failed (${createResponse.status}): ${extractErrorMessage(createResponse)}`);
  }

  const runId = createResponse.json && createResponse.json.runId;
  if (!runId) {
    throw new Error('Create run response did not include runId.');
  }

  const statusUrl = (createResponse.json && createResponse.json.statusUrl)
    ? String(createResponse.json.statusUrl)
    : `${config.apiUrl}/api/ci/runs/${encodeURIComponent(runId)}`;

  const replayedHeader = String(createResponse.headers.get('idempotency-replayed') || '').toLowerCase();
  const replayed = replayedHeader === 'true';

  setOutput('run_id', runId);
  setOutput('status_url', statusUrl);
  setOutput('app_url', createResponse.json && createResponse.json.appUrl ? createResponse.json.appUrl : '');
  setOutput('test_case_count', parseCounter(createResponse.json && createResponse.json.testCaseCount));
  setOutput('idempotency_replayed', replayed ? 'true' : 'false');

  const signalContext = {
    config,
    headers,
    runId,
    cancelOnJobCancel: config.cancelOnJobCancel,
    cancelReason: config.cancelReason,
    cancellationInProgress: false
  };
  const unregisterSignalHandlers = registerSignalHandlers(signalContext);

  if (!config.waitForCompletion) {
    unregisterSignalHandlers();
    appendSummary([
      '## Certyn CI Run',
      '',
      `- Run ID: \`${runId}\``,
      '- Waiting disabled (`wait_for_completion=false`).',
      `- Status URL: ${statusUrl}`
    ]);
    logInfo(`Run ${runId} created. Waiting disabled.`);
    return;
  }

  const deadline = Date.now() + (config.timeoutSeconds * 1000);
  let lastStatus = {
    state: '',
    conclusion: '',
    total: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    pending: 0,
    skipped: 0,
    appUrl: createResponse.json && createResponse.json.appUrl ? createResponse.json.appUrl : ''
  };

  let pollNumber = 0;

  while (Date.now() < deadline) {
    pollNumber += 1;

    const statusResponse = await requestJson(`${config.apiUrl}/api/ci/runs/${encodeURIComponent(runId)}`, {
      method: 'GET',
      headers: {
        'X-API-Key': config.apiKey,
        'User-Agent': 'certyn/action@v1'
      },
      maxAttempts: config.httpMaxAttempts,
      requestTimeoutMs: config.requestTimeoutMs,
      retryLabel: 'get run status'
    });

    if (!statusResponse.ok) {
      if (statusResponse.status === 404 && pollNumber <= 3) {
        logWarn(`Status endpoint returned 404 for run ${runId}; retrying.`);
        await sleep(config.initialPollIntervalSeconds * 1000);
        continue;
      }

      throw new Error(`Status check failed (${statusResponse.status}): ${extractErrorMessage(statusResponse)}`);
    }

    const status = statusResponse.json || {};
    const state = String(status.state || '').toLowerCase();

    lastStatus = {
      state,
      conclusion: status.conclusion || '',
      total: parseCounter(status.total),
      passed: parseCounter(status.passed),
      failed: parseCounter(status.failed),
      blocked: parseCounter(status.blocked),
      pending: parseCounter(status.pending),
      skipped: parseCounter(status.skipped),
      appUrl: status.appUrl || lastStatus.appUrl || ''
    };

    logInfo(
      `poll=${pollNumber} state=${lastStatus.state || 'unknown'} ` +
      `failed=${lastStatus.failed} blocked=${lastStatus.blocked} pending=${lastStatus.pending}`
    );

    if (TERMINAL_STATES.has(state)) {
      unregisterSignalHandlers();
      setStatusOutputs(lastStatus);

      const verdict = evaluateVerdict(state, lastStatus, config);
      appendSummary(buildSummary(runId, statusUrl, lastStatus, verdict));

      if (!verdict.ok) {
        throw new Error(verdict.reason);
      }

      logInfo(`Run ${runId} completed successfully.`);
      return;
    }

    const retryAfterSeconds = parseCounter(status.retryAfterSeconds);
    const waitSeconds = clamp(
      retryAfterSeconds || config.initialPollIntervalSeconds,
      config.initialPollIntervalSeconds,
      config.maxPollIntervalSeconds
    );

    await sleep(waitSeconds * 1000);
  }

  unregisterSignalHandlers();

  if (config.cancelOnTimeout) {
    logWarn(`Timed out waiting for run ${runId}; attempting cancellation.`);
    await cancelRun(config, headers, runId, config.cancelReason || 'Timed out in certyn/action');
  }

  setStatusOutputs(lastStatus);
  appendSummary(buildSummary(runId, statusUrl, lastStatus, { ok: false, reason: 'Timed out waiting for terminal state.' }));
  throw new Error(`Timed out after ${config.timeoutSeconds}s waiting for run ${runId}.`);
}

module.exports = {
  run,
  __private: {
    parseTagsInput,
    parseBoolean,
    inferExternalUrl,
    inferIdempotencyKey,
    evaluateVerdict,
    readConfig
  }
};

if (require.main === module) {
  run().catch((error) => {
    console.error(`[certyn/action] ${error.message}`);
    process.exit(1);
  });
}
