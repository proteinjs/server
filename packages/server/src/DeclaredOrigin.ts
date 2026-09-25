/**
 * A configured value that must be exactly an origin — `scheme://host`, a port when not the scheme's
 * default; never a path, a query, a fragment or a trailing slash — read once at boot. A value that
 * is not one refuses the boot, naming the declaration: a redirect's Location or a policy's source
 * built from a near-origin (`https://app.example.com/`, `HTTPS://App.Example.com`) is one a browser
 * reads differently from how it was written, and the place to find that out is the boot, never a
 * served header.
 */
export class DeclaredOrigin {
  /** `value` as the origin it names, or a refusal naming `declaration` (the config key that carries it). */
  static of(value: string, declaration: string): string {
    let origin: string | undefined;
    try {
      origin = new URL(value).origin;
    } catch {
      origin = undefined;
    }
    if (origin !== value) {
      throw new Error(
        `${declaration}: ${JSON.stringify(value)} is not an origin (scheme://host, a port when not the scheme's default — no path, query, fragment or trailing slash)`
      );
    }
    return origin;
  }
}
