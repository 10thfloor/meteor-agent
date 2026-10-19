const invalid = () => { const error = new Error('Invalid attachment storage reference.'); error.code = 'attachment-storage-invalid'; throw error; };

/** Stable, content-addressed snapshots. Display names never become directories. */
export function attachmentStoragePath({ attachmentId, name, sha256 } = {}) {
  if (typeof attachmentId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(attachmentId)
    || typeof name !== 'string' || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) invalid();
  const cleaned = name.normalize('NFC').replace(/[\x00-\x1f\x7f\\/:<>?*|"']/g, '_').trim().replace(/^\.+/, '') || 'file';
  let filename = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(filename + character, 'utf8') > 160) break;
    filename += character;
  }
  return `/workspace/attachments/${attachmentId}/${sha256}-${filename || 'file'}`;
}
