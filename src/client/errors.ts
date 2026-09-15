// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/** Base class for every error originating from this client. */
export class OparlError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The server responded with a non-2xx HTTP status (or a redirect this client does
 * not follow). `detail` holds a short, sanitised snippet of the response body when
 * a useful textual one is present.
 */
export class OparlApiError extends OparlError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: { status: number; url: string; method: string; body: string; detail?: string }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for HTTP statuses treated as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }

  /** True for an HTTP 404. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, size cap, ...). */
export class OparlNetworkError extends OparlError {}

/** A client-side validation error (e.g. a non-http URL) — no request made. */
export class OparlValidationError extends OparlError {}

/**
 * The response was not what OParl promises: not JSON, an HTML page, an empty body,
 * an OParl error object, or an object of the wrong type (e.g. no `data` array on a
 * list page).
 */
export class OparlParseError extends OparlError {}

/**
 * A link or redirect the server handed out points somewhere this client refuses to
 * follow — another host, or a downgrade from https to http. Links are only followed
 * on the server they came from.
 */
export class OparlLinkError extends OparlError {}
