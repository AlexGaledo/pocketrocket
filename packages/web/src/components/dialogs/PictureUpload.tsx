import { useId, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { IMAGE_TYPES, uploadImage } from '../../lib/media';
import { Button } from '../ui';

/** Picks one image, shrinks and uploads it, and hands back its reference. A refusal is said right here. */
export function PictureUpload({ onUploaded, label = 'Upload picture' }: { onUploaded: (ref: string) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      onUploaded(await uploadImage(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      // The same file can be picked again after a refusal.
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input ref={input} type="file" accept={IMAGE_TYPES.join(',')} hidden tabIndex={-1} aria-hidden onChange={(e) => void pick(e.target.files?.[0])} />
      <Button type="button" size="sm" disabled={busy} aria-describedby={error ? errorId : undefined} onClick={() => input.current?.click()}>
        <Upload size={14} aria-hidden />{busy ? 'Uploading…' : label}
      </Button>
      {error && <span id={errorId} role="alert" className="text-hint text-bad">{error}</span>}
    </div>
  );
}
