/**
 * Saves a fetched file the way a link with `download` would. Re-typed as octet-stream first, so the URL is only ever
 * something to save: were it opened as a page, a text/html or SVG type would run in the app's origin.
 */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // The click has started the download by now; a moment's grace for a slow browser, then the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}
