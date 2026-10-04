/** Explicit local proxy origin; no wildcard ports or external preview hosts. */
export function parsePreviewOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^http:\/\/(127\.0\.0\.1|localhost)(?::([1-9]\d{0,4}))?\/?$/.exec(value);
  if (value.trim() !== value || !match || (match[2] !== undefined && Number(match[2]) > 65535)) {
    throw new Error('TMC_PREVIEW_ORIGIN must be an HTTP origin on 127.0.0.1 or localhost, with a valid port and no path.');
  }
  return new URL(value).origin;
}

export function previewFrameAncestors(value: string | undefined): string {
  const origin = parsePreviewOrigin(value);
  return origin ? `'self' ${origin} vscode-webview: vscode-file://vscode-app` : "'none'";
}
