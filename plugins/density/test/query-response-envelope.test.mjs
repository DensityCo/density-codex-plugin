import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  publicQueryResponse,
  queryResponseDiagnostics,
} from '../mcp-server/query-response-envelope.mjs';

test('the public query response keeps evidence and removes execution mechanics', () => {
  const value = {
    ok: true,
    dataDir: '/private/customer',
    cli: { path: '/private/density', args: ['query-db'] },
    performance: { totalMs: 40 },
    result: {
      kind: 'density.query-db.v1',
      organizationId: 'org_private',
      sql: 'SELECT room_name FROM density_local_metrics',
      executedSql: 'SELECT room_name FROM private_metrics',
      rowCount: 1,
      rows: [{ room_name: 'Boardroom', used_percent: 42 }],
      completeForExecutedSql: true,
      sqlBounded: false,
      evidence: {
        id: `qe_${'a'.repeat(64)}`,
        artifact: '/private/customer/evidence.json',
        sha256: 'sha256:private',
        byteCount: 99,
        rowCount: 1,
        completeForExecutedSql: true,
        sqlBounded: false,
      },
      performance: { duckDbExecutionMs: 20 },
    },
    declaredAnalysisContext: {
      scope: 'Metro Tower',
      population: 'meeting rooms',
      denominator: 'measured working hours',
    },
  };

  const response = publicQueryResponse(value);
  assert.deepEqual(response.result.rows, value.result.rows);
  assert.equal(response.result.evidence.id, value.result.evidence.id);
  assert.equal(response.result.complete, true);
  assert.equal(response.result.displayedSubset, false);
  assert.equal(response.result.evidence.complete, undefined);
  assert.equal(response.result.evidence.displayedSubset, undefined);
  assert.deepEqual(response.declaredAnalysisContext, value.declaredAnalysisContext);
  const serialized = JSON.stringify(response);
  assert.doesNotMatch(serialized, /private|DuckDB|executedSql|sqlBounded|sha256|byteCount|dataDir|organizationId|performance|SELECT/);
});

test('a query failure gives the analyst a typed safe response', () => {
  const value = {
    ok: false,
    dataDir: '/private/customer',
    sql: 'SELECT broken',
    error: 'Binder Error: column "local_date" must appear in the GROUP BY clause.',
    declaredAnalysisContext: { scope: 'Metro Tower' },
  };

  assert.deepEqual(publicQueryResponse(value), {
    ok: false,
    declaredAnalysisContext: { scope: 'Metro Tower' },
    code: 'QUERY_INVALID',
    error: 'The historical query did not match the current Density schema.',
    retryable: true,
  });
  assert.equal(queryResponseDiagnostics(value)['density/diagnostics'], value);
});
