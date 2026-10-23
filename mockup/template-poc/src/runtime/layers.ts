import { TemplateCache } from './cache';
import { prepareLayers, sha256Hex } from './tar';
import type { LayerFile, LayerSource, LoadedLayer, LogFn, TemplateSet } from './types';

export async function loadTemplateSet(
  sources: LayerSource[],
  cache: TemplateCache,
  log: LogFn
): Promise<TemplateSet> {
  if (sources.length === 0) throw new Error('At least one template layer is required');

  await prepareLayers(sources, cache, log);

  const layers: LoadedLayer[] = [];
  for (const source of sources) {
    layers.push({ source, files: await cache.readLayer(source.digest) });
  }

  const files = new Map<string, LayerFile>();
  layers.forEach((layer, index) => {
    for (const [path, data] of layer.files) {
      files.set(path, { path, layer: index, data });
    }
  });

  const compositeDigest = await sha256Hex(
    new TextEncoder().encode(
      sources.map((layer) => `${layer.id}:${layer.digest}`).join('\n')
    )
  );

  return {
    layers,
    files,
    compositeDigest,
  };
}
