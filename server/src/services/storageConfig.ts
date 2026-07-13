export function assertPhotoStorageEnvironment(input: {
  nodeEnv: string | undefined;
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
  bucket: string | undefined;
}): void {
  const hasAccess = Boolean(input.accessKeyId?.trim());
  const hasSecret = Boolean(input.secretAccessKey?.trim());
  if (hasAccess !== hasSecret) {
    throw new Error('S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY deben configurarse juntos');
  }
  if (input.nodeEnv === 'production') {
    if (!hasAccess || !hasSecret || !input.bucket?.trim()) {
      throw new Error(
        'Producción biométrica requiere almacenamiento durable: S3_ACCESS_KEY_ID, ' +
          'S3_SECRET_ACCESS_KEY y S3_BUCKET'
      );
    }
  }
}
