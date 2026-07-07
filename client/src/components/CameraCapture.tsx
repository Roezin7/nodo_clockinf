import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';

/**
 * Captura de foto con la cámara del dispositivo (webcam o frontal).
 * Mismo pipeline que el kiosco: getUserMedia → canvas → JPEG 0.8.
 * Requiere contexto seguro (https o localhost).
 */
export default function CameraCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (file: File) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Este navegador no permite usar la cámara (se requiere https).');
      return;
    }
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setError('No se pudo acceder a la cámara. Revisa los permisos del navegador.'));
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function capture(): void {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(new File([blob], 'enrolamiento.jpg', { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.8
    );
  }

  if (error) {
    return (
      <div className="rounded-control border border-line bg-sunken p-3">
        <p className="text-13 text-danger">{error}</p>
        <div className="mt-2 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cerrar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-control border border-line bg-sunken p-3">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onCanPlay={() => setReady(true)}
        className="aspect-[4/3] w-full -scale-x-100 rounded-control bg-ink object-cover"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
        <Button size="sm" onClick={capture} disabled={!ready}>
          Capturar
        </Button>
      </div>
    </div>
  );
}
