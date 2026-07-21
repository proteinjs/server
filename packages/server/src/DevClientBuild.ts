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
};

export class DevClientBuild {
  private static current: DevClientBuildInfo | undefined;

  static record(info: DevClientBuildInfo): void {
    this.current = info;
  }

  static get(): DevClientBuildInfo | undefined {
    return this.current;
  }
}
