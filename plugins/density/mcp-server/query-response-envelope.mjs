const PRIVATE_FIELDS = new Set([
  'args',
  'artifact',
  'byteCount',
  'capabilities',
  'cli',
  'command',
  'completeForExecutedSql',
  'dataDir',
  'executedSql',
  'html',
  'organizationId',
  'performance',
  'png',
  'sha256',
  'sql',
  'sqlBounded',
  'stderr',
  'stdout',
]);

const compactPublicValue = (value) => {
  if (Array.isArray(value)) return value.map(compactPublicValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (
    PRIVATE_FIELDS.has(key) ? [] : [[key, compactPublicValue(child)]]
  )));
};

const failureCode = (value) => {
  if (value.unsupported === true) return 'QUERY_UNSUPPORTED';
  if (/timed out/i.test(value.error ?? '')) return 'QUERY_TIMEOUT';
  if (/\b(?:binder|catalog|parser) error\b/i.test(value.error ?? '')) return 'QUERY_INVALID';
  return 'QUERY_FAILED';
};

const failureMessage = (code) => {
  if (code === 'QUERY_UNSUPPORTED') return 'Historical analysis is unavailable in this Density runtime.';
  if (code === 'QUERY_TIMEOUT') return 'The historical analysis did not finish in time.';
  if (code === 'QUERY_INVALID') return 'The historical query did not match the current Density schema.';
  return 'Density could not complete the historical analysis.';
};

export function publicQueryResponse(value) {
  const publicValue = compactPublicValue(value);
  if (value?.ok !== false) {
    return value?.result && typeof value.result === 'object'
      ? {
          ...publicValue,
          result: {
            ...publicValue.result,
            complete: value.result.completeForExecutedSql,
            displayedSubset: value.result.sqlBounded,
          },
        }
      : publicValue;
  }
  const code = failureCode(value);
  return {
    ...publicValue,
    code,
    error: failureMessage(code),
    retryable: code === 'QUERY_INVALID',
  };
}

export function queryResponseDiagnostics(value) {
  return { 'density/diagnostics': value };
}
