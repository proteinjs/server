/**
 * Why the server refused a socket handshake, as a code. The server sends it in the refusal's `data`
 * (`{ code }`): socket.io's CONNECT_ERROR packet carries the error's `message` and `data`, which the
 * client reads as its `connect_error`'s `error.message` and `error.data`. A client decides what a
 * refusal means by this code — never by the message's wording, which is for people reading a log.
 *
 * Both sides import the code from here (the server's refusal and the browser's reading of it), so
 * the value is written once.
 */
export const SocketRefusalCode = {
  /**
   * No signed-in session behind the handshake's cookie. Final for the refused socket while the
   * cookie carries the same session: a retry under it can only be refused again.
   */
  NO_SESSION: 'NO_SESSION',
} as const;

export type SocketRefusalCode = (typeof SocketRefusalCode)[keyof typeof SocketRefusalCode];
