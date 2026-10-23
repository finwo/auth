export interface LayerSource {
  id: string;
  label: string;
  digest: string;
  url: string;
}

export interface TemplateManifest {
  api: number;
  base: LayerSource;
  overlays: LayerSource[];
}

export interface LoadedLayer {
  source: LayerSource;
  files: Map<string, Uint8Array>;
}

export interface LayerFile {
  path: string;
  layer: number;
  data: Uint8Array;
}

export interface TemplateSet {
  layers: LoadedLayer[];
  files: Map<string, LayerFile>;
  compositeDigest: string;
}

export type LogKind = 'cache' | 'network' | 'info' | 'error';

export type LogFn = (kind: LogKind, message: string) => void;
