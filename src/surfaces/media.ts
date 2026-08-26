// Media type from a filename and back, for the two surfaces that move artifact bytes.
//
// ONE table, both directions. The MCP adapter needs it on the way in (a path upload whose type is
// `application/octet-stream` is refused as un-inlineable by the receiving side) and the CLI needs
// it on the way out (a downloaded file with no extension is one nothing opens). Two copies of a
// mapping is the "one fact stated twice" shape this codebase keeps paying for, so it is here rather
// than in either caller.
//
// SMALL AND EXPLICIT, not a full IANA table. What belongs here is what agents actually hand each
// other; an unknown type answers `undefined` so the caller's own value or a stated default wins
// rather than a guess. A WRONG extension is worse than none, because a harness picks its reader
// from it.

const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  yaml: "text/yaml",
  yml: "text/yaml",
};

/** The first extension listed for a type wins on the way back, so `image/jpeg` answers `jpg`. */
const BY_TYPE = new Map<string, string>();
for (const [ext, type] of Object.entries(BY_EXTENSION)) if (!BY_TYPE.has(type)) BY_TYPE.set(type, ext);

/** Media type for a file path, or undefined when the extension is not one we name. */
export function mediaTypeForPath(path: string): string | undefined {
  const ext = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[ext];
}

/** File extension for a media type (no dot), or undefined. Parameters are stripped, so
 *  `text/plain; charset=utf-8` answers `txt`. */
export function extensionFor(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;
  return BY_TYPE.get(mediaType.split(";")[0].trim().toLowerCase());
}
