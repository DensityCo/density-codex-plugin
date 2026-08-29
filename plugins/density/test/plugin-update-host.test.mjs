import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPluginUpdate } from '../scripts/density-lib.mjs';

const latestManifestResponse = () => ({
  ok: true,
  json: async () => ({ version: '99.0.0' }),
});

test('returns host-specific plugin update instructions', async () => {
  const originalFetch = globalThis.fetch;
  const originalHost = process.env.DENSITY_PLUGIN_HOST;
  const originalUpdateCommand = process.env.DENSITY_PLUGIN_UPDATE_COMMAND;
  globalThis.fetch = async () => latestManifestResponse();
  try {
    delete process.env.DENSITY_PLUGIN_HOST;
    const codex = await checkPluginUpdate();
    assert.equal(codex.pluginSelector, 'density@densityai');
    assert.match(codex.command, /^codex plugin /);
    assert.equal(codex.userPrompt, 'update @density');
    assert.equal(codex.pluginUri, 'plugin://density@densityai');

    process.env.DENSITY_PLUGIN_HOST = 'claude';
    process.env.DENSITY_PLUGIN_UPDATE_COMMAND = 'node /tmp/install-density-claude-plugin.mjs';
    const claude = await checkPluginUpdate();
    assert.equal(claude.pluginSelector, 'density@density-local');
    assert.equal(claude.userPrompt, 'update density');
    assert.equal(claude.command, 'node /tmp/install-density-claude-plugin.mjs');
    assert.equal(Object.hasOwn(claude, 'pluginUri'), false);
    assert.match(claude.prompt, /Restart Claude/);

    process.env.DENSITY_PLUGIN_HOST = 'claude-desktop';
    delete process.env.DENSITY_PLUGIN_UPDATE_COMMAND;
    const desktop = await checkPluginUpdate();
    assert.equal(desktop.pluginSelector, 'density');
    assert.equal(desktop.userPrompt, 'update density');
    assert.match(desktop.command, /Claude Desktop/);
    assert.match(desktop.prompt, /\.mcpb/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHost === undefined) delete process.env.DENSITY_PLUGIN_HOST;
    else process.env.DENSITY_PLUGIN_HOST = originalHost;
    if (originalUpdateCommand === undefined) delete process.env.DENSITY_PLUGIN_UPDATE_COMMAND;
    else process.env.DENSITY_PLUGIN_UPDATE_COMMAND = originalUpdateCommand;
  }
});
