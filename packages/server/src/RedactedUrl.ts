/**
 * A request url in the form a log carries it: the path and the query's KEYS, every query VALUE
 * replaced by one fixed mark — `/login/password-reset?token=…` → `/login/password-reset?token=<redacted>` —
 * and a fragment's whole content replaced by the same mark — `/invite#access=…` → `/invite#<redacted>`.
 *
 * A value in a url is never an operator's business: a reset link, an invite link and the reset
 * page's token check each carry a live credential in their query, and a log line that prints the
 * url whole hands that credential to everyone who reads the log. The keys stay — they are the
 * route's own vocabulary and say what the request asked for. A route that wants a value in the log
 * logs it itself, digested. The path is printed as it came: a route that puts a secret in its path
 * owns that choice.
 *
 * A fragment has no keys to keep: it holds whatever the link put there (a client route, a bare
 * token, `access=…`), and a link that keeps a credential away from every server puts it exactly
 * there. A browser never sends its fragment, but a page's `location.href` (the url a client error
 * report names) still holds it, and a hand-written request target can carry one to the request log.
 * The mark stands in its place rather than the fragment vanishing, so the line still says the url
 * had one — the same mark, with or without a query in front of it.
 *
 * The server's one owner of this form: the request log's lines and the request metadata (what a
 * log writer attaches to every line a request writes) both come from here.
 */
export class RedactedUrl {
  static readonly MARK = '<redacted>';

  /** The url as a log may print it; a url with no query and no fragment comes back unchanged. */
  static of(url: string): string {
    // The first `#` starts the fragment wherever it falls: a `?`, `=` or `&` after it is fragment.
    const fragmentStart = url.indexOf('#');
    if (fragmentStart === -1) {
      return RedactedUrl.withQuery(url);
    }

    return `${RedactedUrl.withQuery(url.slice(0, fragmentStart))}${RedactedUrl.fragment(url.slice(fragmentStart + 1))}`;
  }

  /** A url with no fragment → the path as it came, then every query piece in its printed form. */
  private static withQuery(url: string): string {
    const queryStart = url.indexOf('?');
    if (queryStart === -1) {
      return url;
    }

    const pieces = url
      .slice(queryStart + 1)
      .split('&')
      .map((piece) => RedactedUrl.piece(piece));
    return `${url.slice(0, queryStart)}?${pieces.join('&')}`;
  }

  /**
   * One `key=value` piece → `key=<mark>`. A piece with no `=` has no key to keep — as far as the
   * log can tell it is all value (a bare `?<token>` link is that shape) — so the mark replaces it
   * whole. An empty piece (`a=1&&b=2`) carries nothing and stays empty.
   */
  private static piece(piece: string): string {
    if (!piece) {
      return piece;
    }

    const equals = piece.indexOf('=');
    return equals === -1 ? RedactedUrl.MARK : `${piece.slice(0, equals)}=${RedactedUrl.MARK}`;
  }

  /** A fragment's content → `#<mark>`, all of it value. An empty fragment carries nothing and stays `#`. */
  private static fragment(content: string): string {
    return content ? `#${RedactedUrl.MARK}` : '#';
  }
}
