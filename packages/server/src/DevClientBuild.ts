/**
 * Live state of the in-process dev client build (webpack-dev-middleware). Recorded on every
 * completed compile; absent in production and when hot client builds are disabled.
 *
 * This exists so the running bundle is VERIFIABLE: the dev script tags carry `?v=<hash>` (see
 * reactApp.ts) and `/dev/build-info` reports the server's current compile — a page whose script
 * src hash matches build-info is provably running the latest build (no more guessing whether a
 * reload raced the compiler).
 */
export type DevClientBuildInfo = {
  /** Webpack compilation hash — changes whenever compiled output changes. */
  hash: string;
  builtAt: string;
  durationMs?: number;
  errorCount: number;
  /**
   * The entrypoint's script files (`app.js`, `vendor.js`, …) in the compile's own load order —
   * the dev page's bundle tags are rendered from THIS list (reactApp.ts), so the page follows the
   * chunk graph the webpack config declares instead of a hard-coded pair of names.
   */
  assets: string[];
};

/** A completed compile's stats as the record reads them: `stats.toJson(DevClientBuild.STATS_OPTIONS)`. */
export type DevClientBuildStats = {
  hash: string;
  time?: number;
  errors?: unknown[];
  /** Each entrypoint's files in the compile's own load order (webpack 4 named them as strings). */
  entrypoints?: Record<string, { assets?: (string | { name: string })[] }>;
};

export class DevClientBuild {
  /** What the compile's `done` hook asks `stats.toJson` for — only the fields a record reads. */
  static readonly STATS_OPTIONS = {
    all: false,
    hash: true,
    timings: true,
    errors: true,
    entrypoints: true,
    chunkGroupAssets: true,
  } as const;

  private static current: DevClientBuildInfo | undefined;

  static record(info: DevClientBuildInfo): void {
    this.current = info;
  }

  static get(): DevClientBuildInfo | undefined {
    return this.current;
  }

  /** The record of one completed compile, from its stats. */
  static fromStats(stats: DevClientBuildStats): DevClientBuildInfo {
    return {
      hash: stats.hash,
      builtAt: new Date().toISOString(),
      durationMs: stats.time,
      errorCount: stats.errors?.length ?? 0,
      assets: this.entrypointScripts(stats),
    };
  }

  /**
   * The entrypoints' script files in the compile's own load order — what the dev page's bundle
   * tags render (reactApp.ts). Source maps are not scripts.
   */
  private static entrypointScripts(stats: DevClientBuildStats): string[] {
    return Object.values(stats.entrypoints ?? {}).flatMap((entrypoint) =>
      (entrypoint.assets ?? [])
        .map((asset) => (typeof asset === 'string' ? asset : asset.name))
        .filter((name) => name.endsWith('.js'))
    );
  }
}
