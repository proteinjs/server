import express from 'express';
import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getServerRenderedHeadTags = () =>
  SourceRepository.get().objects<ServerRenderedHeadTag>('@proteinjs/server-api/ServerRenderedHeadTag');

/**
 * Markup rendered into the `<head>` of the page that ships the client bundle, on every request for
 * it — for tags the document must carry before any script runs (a `<meta>` a browser reads at
 * parse time, a `<link>`). The request is passed so a tag can name the page being served.
 *
 * The head counterpart of `ServerRenderedScript`: every implementation is rendered concurrently
 * and emitted in registration order.
 */
export interface ServerRenderedHeadTag extends Loadable {
  /** The tag's markup for this request, or an empty string to render nothing. */
  headTag(request: express.Request): Promise<string>;
}
