/** Un único reintento acotado para recuperar respuestas perdidas idempotentes. */
export async function retryIdentityTransport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}
