// Typed runtime errors. `code` is the stable machine-readable slug; it maps to the
// RFC 9457 problem `type` at the HTTP boundary and to a status body for non-error
// outcomes. Keep codes kebab/snake stable, because clients branch on them.

export class RadiaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RadiaError";
  }
}
