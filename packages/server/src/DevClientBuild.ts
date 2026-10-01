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
   * chunk graph the webpack config declares instead of a hard-coded pair of names. Never a
   * hot-update chunk (see `fromStats`).
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
  /** Every asset of the compile, with the info webpack declared on it. */
  assets?: { name: string; info?: { hotModuleReplacement?: boolean } }[];
};

export class DevClientBuild {
  /**
   * What the compile's `done` hook asks `stats.toJson` for — only the fields a record reads.
   * `assets` carries webpack's own info on each asset; `cachedAssets` keeps the ones an incremental
   * compile left untouched in that list (under `all: false` they are otherwise dropped).
   */
  static readonly STATS_OPTIONS = {
    all: false,
    hash: true,
    timings: true,
    errors: true,
    entrypoints: true,
    chunkGroupAssets: true,
    assets: true,
    cachedAssets: true,
  } as const;

  private static current: DevClientBuildInfo | undefined;

  static record(info: DevClientBuildInfo): void {
    this.current = info;
  }

  static get(): DevClientBuildInfo | undefined {
    return this.current;
  }

  /**
   * The record of one completed compile, from its stats.
   *
   * `assets` is the entrypoints' script files, in the compile's own load order, LESS the hot-update
   * chunks: on every incremental compile HotModuleReplacementPlugin emits
   * `<entry>.<previous hash>.hot-update.js` and adds it to the entry chunk's files, so the stats'
   * entrypoint listing carries it beside the entry's own scripts. That chunk is an HMR payload for a
   * page already running the previous compile (it calls `webpackHotUpdate…` on a runtime that must
   * already exist) — injected into a fresh page load it throws and the page is broken until the next
   * full compile. Webpack declares what each asset is (`info.hotModuleReplacement`), and that
   * declaration, never a file name, is what leaves them out.
   */
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
   * tags render (reactApp.ts). Source maps are not scripts; hot-update chunks are not page scripts.
   */
  private static entrypointScripts(stats: DevClientBuildStats): string[] {
    const hotUpdates = new Set(
      (stats.assets ?? []).filter((asset) => asset.info?.hotModuleReplacement).map((asset) => asset.name)
    );
    return Object.values(stats.entrypoints ?? {}).flatMap((entrypoint) =>
      (entrypoint.assets ?? [])
        .map((asset) => (typeof asset === 'string' ? asset : asset.name))
        .filter((name) => name.endsWith('.js') && !hotUpdates.has(name))
    );
  }
}
