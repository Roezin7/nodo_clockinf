export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, code?: string) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'No autorizado') => new HttpError(401, msg);
export const forbidden = (msg = 'Permiso denegado') => new HttpError(403, msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, msg);
export const conflict = (msg: string, code?: string) => new HttpError(409, msg, code);
