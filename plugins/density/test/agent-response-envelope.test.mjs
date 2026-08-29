import assert from 'node:assert/strict';
import { test } from 'node:test';

import { standardizeAgentResponse } from '../mcp-server/agent-response-envelope.mjs';

test('setup preserves its payload and exposes an actionable workflow response', () => {
  const nextAction = {
    id: 'auth_login',
    label: 'Run Density browser auth.',
    tool: 'auth_login',
    args: { dataDir: '/tmp/density' },
    command: 'density auth login',
  };
  const result = standardizeAgentResponse('setup', {
    ok: false,
    dataDir: '/tmp/density',
    checks: [],
    nextAction,
  });

  assert.equal(result.contract, 'density.agent-response.v1');
  assert.equal(result.operation, 'setup');
  assert.equal(result.status, 'action_required');
  assert.equal(result.terminal, false);
  assert.equal(result.code, 'SETUP_ACTION_REQUIRED');
  assert.equal(result.userAction, null);
  assert.deepEqual(result._next, {
    tool: 'auth_login',
    args: { dataDir: '/tmp/density' },
    command: 'density auth login',
  });
  assert.equal(result.dataDir, '/tmp/density');
  assert.equal(result.nextAction, nextAction);
});

test('auth login exposes a terminal success without inventing a next action', () => {
  const result = standardizeAgentResponse('auth_login', {
    ok: true,
    dataDir: '/tmp/density',
    stdout: 'Authenticated.',
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.terminal, true);
  assert.equal(result.code, 'AUTH_LOGIN_SUCCEEDED');
  assert.equal(result.userAction, null);
  assert.equal(result._next, null);
  assert.equal(result.stdout, 'Authenticated.');
});

test('onboarding reports a background job as in progress with a polling action', () => {
  const result = standardizeAgentResponse('onboard_customer', {
    ok: true,
    mode: 'recent-plus-background',
    dataDir: '/tmp/density',
    backgroundDeepSync: {
      enabled: true,
      status: { status: 'running' },
      pollingTool: 'onboarding_status',
    },
  });

  assert.equal(result.status, 'in_progress');
  assert.equal(result.terminal, false);
  assert.equal(result.code, 'ONBOARDING_IN_PROGRESS');
  assert.deepEqual(result._next, {
    tool: 'onboarding_status',
    args: { dataDir: '/tmp/density' },
    retryAfterSeconds: 5,
  });
});

test('onboarding status distinguishes running, complete, and failed jobs', () => {
  const running = standardizeAgentResponse('onboarding_status', {
    ok: true,
    dataDir: '/tmp/density',
    backgroundDeepSync: { status: 'running' },
    nextAction: {
      id: 'check_background_deep_sync',
      label: 'Check again later.',
      tool: 'onboarding_status',
      args: { dataDir: '/tmp/density' },
    },
  });
  const complete = standardizeAgentResponse('onboarding_status', {
    ok: true,
    backgroundDeepSync: { status: 'complete' },
  });
  const failed = standardizeAgentResponse('onboarding_status', {
    ok: true,
    backgroundDeepSync: { status: 'failed', error: 'Sync failed.' },
  });

  assert.deepEqual(
    [running.status, running.terminal, running.code],
    ['in_progress', false, 'ONBOARDING_IN_PROGRESS'],
  );
  assert.equal(running._next.retryAfterSeconds, 5);
  assert.deepEqual(
    [complete.status, complete.terminal, complete.code],
    ['succeeded', true, 'ONBOARDING_COMPLETE'],
  );
  assert.deepEqual(
    [failed.status, failed.terminal, failed.code],
    ['failed', true, 'ONBOARDING_FAILED'],
  );
});

test('an explicit user prompt makes a failed operation actionable', () => {
  const result = standardizeAgentResponse('auth_login', {
    ok: false,
    error: 'Approval was denied.',
    nextAction: {
      id: 'approve_login',
      label: 'Approve the login request.',
      userPrompt: 'Open the approval link and approve Density.',
    },
  });

  assert.equal(result.status, 'action_required');
  assert.equal(result.terminal, false);
  assert.equal(result.code, 'AUTH_LOGIN_ACTION_REQUIRED');
  assert.equal(result.userAction, 'Open the approval link and approve Density.');
  assert.equal(result._next, null);
});
