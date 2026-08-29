const RESPONSE_CONTRACT = 'density.agent-response.v1';
const DEFAULT_RETRY_AFTER_SECONDS = 5;

const OPERATION_PREFIX = Object.freeze({
  setup: 'SETUP',
  auth_login: 'AUTH_LOGIN',
  onboard_customer: 'ONBOARDING',
  onboarding_status: 'ONBOARDING',
});

const compactObject = (value) => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => entry !== undefined),
);

const nextFromAction = (action, { retryAfterSeconds } = {}) => {
  if (!action || (!action.tool && !action.command)) return null;
  return compactObject({
    tool: action.tool,
    args: action.args,
    command: action.command,
    retryAfterSeconds,
  });
};

const workflowState = (operation, value) => {
  const prefix = OPERATION_PREFIX[operation];
  const jobStatus = value.backgroundDeepSync?.status?.status
    ?? value.backgroundDeepSync?.status;

  if (operation === 'onboarding_status' && jobStatus === 'failed') {
    return { status: 'failed', terminal: true, code: 'ONBOARDING_FAILED' };
  }
  if (operation === 'onboarding_status' && jobStatus === 'complete') {
    return { status: 'succeeded', terminal: true, code: 'ONBOARDING_COMPLETE' };
  }
  if (jobStatus === 'running') {
    return { status: 'in_progress', terminal: false, code: 'ONBOARDING_IN_PROGRESS' };
  }
  if (value.nextAction) {
    return { status: 'action_required', terminal: false, code: `${prefix}_ACTION_REQUIRED` };
  }
  if (value.ok === false) {
    return { status: 'failed', terminal: true, code: `${prefix}_FAILED` };
  }
  return {
    status: 'succeeded',
    terminal: true,
    code: operation === 'onboarding_status' ? 'ONBOARDING_STATUS_READY' : `${prefix}_SUCCEEDED`,
  };
};

export function standardizeAgentResponse(operation, value) {
  if (!OPERATION_PREFIX[operation]) {
    throw new Error(`Unsupported agent response operation: ${operation}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent response for ${operation} must be an object.`);
  }

  const state = workflowState(operation, value);
  const pollingAction = operation === 'onboard_customer'
    && state.status === 'in_progress'
    && !value.nextAction
    ? { tool: 'onboarding_status', args: { dataDir: value.dataDir } }
    : value.nextAction;
  const retryAfterSeconds = state.status === 'in_progress'
    ? DEFAULT_RETRY_AFTER_SECONDS
    : undefined;

  return {
    ...value,
    contract: RESPONSE_CONTRACT,
    operation,
    ...state,
    userAction: value.nextAction?.userPrompt ?? null,
    _next: nextFromAction(pollingAction, { retryAfterSeconds }),
  };
}
