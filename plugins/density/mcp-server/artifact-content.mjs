import path from 'node:path';
import { pathToFileURL } from 'node:url';

const panelTargets = (value) => [
  value?.floorplanPanelTarget,
  value?.panelTarget,
].filter(Boolean);

export function localHtmlResourceLinks(value) {
  return panelTargets(value).flatMap((target) => {
    const artifactPath = typeof target.path === 'string' ? target.path : '';
    const isLocalHtml = target.kind === 'local-html'
      || (target.kind === 'local-file' && path.extname(artifactPath).toLowerCase() === '.html');
    if (!isLocalHtml || !path.isAbsolute(artifactPath)) return [];
    return [{
      type: 'resource_link',
      name: target.report || 'density-local-html',
      title: target.title || 'Open Density HTML artifact',
      uri: pathToFileURL(artifactPath).href,
      mimeType: 'text/html',
    }];
  });
}
