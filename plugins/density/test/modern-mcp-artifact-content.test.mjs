import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localHtmlResourceLinks } from '../mcp-server/artifact-content.mjs';

test('localHtmlResourceLinks exposes a clickable live floorplan', () => {
  assert.deepEqual(localHtmlResourceLinks({
    floorplanPanelTarget: {
      kind: 'local-html',
      title: 'Floor 03 live availability',
      report: 'wayfinding-floorplan',
      path: '/tmp/wayfinding-floorplan.html',
    },
  }), [{
    type: 'resource_link',
    name: 'wayfinding-floorplan',
    title: 'Floor 03 live availability',
    uri: 'file:///tmp/wayfinding-floorplan.html',
    mimeType: 'text/html',
  }]);
});

test('localHtmlResourceLinks ignores non-local and non-HTML targets', () => {
  assert.deepEqual(localHtmlResourceLinks({ panelTarget: { kind: 'local-html', path: 'report.html' } }), []);
  assert.deepEqual(localHtmlResourceLinks({ panelTarget: { kind: 'local-file', path: '/tmp/report.pdf' } }), []);
  assert.deepEqual(localHtmlResourceLinks({}), []);
});
