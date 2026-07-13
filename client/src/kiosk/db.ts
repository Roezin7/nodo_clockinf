import type { PunchType } from '@clockai/shared';

const DATABASE_NAME = 'clockai-kiosk-v1';
const DATABASE_VERSION = 1;
const EVENTS_STORE = 'events';
const META_STORE = 'meta';
const NEXT_SEQUENCE_KEY = 'next-sequence';
const INSTALLATION_ID_KEY = 'client-installation-id';
const CLOCK_SKEW_KEY = 'clock-skew-seconds';

export type QueueState = 'provisional' | 'pending' | 'event_accepted' | 'rejected';

export interface QueuedEventPayload {
  employeeNumber: number;
  punchType: PunchType;
  capturedAt: string;
  clientSequence: number;
  punchId: string | null;
  employeeName: string | null;
  punchedAtLocal: string | null;
  timezone: string | null;
  evidenceStatus: 'captured' | 'camera_unavailable';
  clientInstallationId: string;
  clientClockSkewSeconds: number | null;
  /** Se persiste antes de enviar el attempt para sobrevivir respuestas perdidas. */
  identitySessionId: string | null;
  identityAttemptId: string | null;
  identityAttemptCapturedAt: string | null;
  identityOutcome: 'pending' | 'verified' | 'identity_review';
  identityBypassReason: 'camera_unavailable' | 'provider_unavailable' | 'offline' | null;
}

interface StoredEvent {
  id: string;
  state: QueueState;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError: string | null;
  payloadIv: ArrayBuffer;
  payloadCiphertext: ArrayBuffer;
  photoIv: ArrayBuffer;
  photoCiphertext: ArrayBuffer;
  photoMime: string;
}

interface MetaRecord {
  key: string;
  value: number;
}

export interface QueuedEvent {
  id: string;
  state: QueueState;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  payload: QueuedEventPayload;
}

export interface QueueStats {
  pending: number;
  rejected: number;
}

export interface PunchAcknowledgement {
  punchId: string;
  employeeName?: string | null;
  punchedAtLocal?: string | null;
  timezone?: string | null;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

let databasePromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB no está disponible'));
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        const events = db.createObjectStore(EVENTS_STORE, { keyPath: 'id' });
        events.createIndex('state', 'state', { unique: false });
        events.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('No fue posible abrir IndexedDB'));
    request.onblocked = () => reject(new Error('La base local está bloqueada por otra pestaña'));
  });
  return databasePromise;
}

function cryptoKey(token: string): Promise<CryptoKey> {
  let promise = keyCache.get(token);
  if (!promise) {
    promise = crypto.subtle
      .digest('SHA-256', textEncoder.encode(token))
      .then((digest) => crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    keyCache.set(token, promise);
  }
  return promise;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

function additionalData(id: string, kind: 'payload' | 'photo'): ArrayBuffer {
  return exactBuffer(textEncoder.encode(`clockai-kiosk-v1:${id}:${kind}`));
}

async function encrypt(
  token: string,
  id: string,
  kind: 'payload' | 'photo',
  plaintext: BufferSource
): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  if (!crypto?.subtle) throw new Error('El cifrado del dispositivo no está disponible');
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(id, kind) },
    await cryptoKey(token),
    plaintext
  );
  return { iv: iv.buffer.slice(0), ciphertext };
}

async function decrypt(
  token: string,
  id: string,
  kind: 'payload' | 'photo',
  iv: ArrayBuffer,
  ciphertext: ArrayBuffer
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: additionalData(id, kind) },
    await cryptoKey(token),
    ciphertext
  );
}

async function decodePayload(token: string, record: StoredEvent): Promise<QueuedEventPayload> {
  const bytes = await decrypt(
    token,
    record.id,
    'payload',
    record.payloadIv,
    record.payloadCiphertext
  );
  const payload = JSON.parse(textDecoder.decode(bytes)) as QueuedEventPayload;
  // Upgrade path for encrypted events queued by the build immediately before
  // installation IDs existed. The generated ID is durable in the same DB.
  payload.clientInstallationId ||= await getClientInstallationId();
  // Un evento histórico sin snapshot debe permanecer en null: jamás se le
  // aplica retroactivamente una medición de reloj obtenida después.
  if (!Object.prototype.hasOwnProperty.call(payload, 'clientClockSkewSeconds')) {
    payload.clientClockSkewSeconds = null;
  }
  payload.identitySessionId ??= null;
  payload.identityAttemptId ??= null;
  payload.identityAttemptCapturedAt ??= null;
  payload.identityOutcome ??= 'identity_review';
  payload.identityBypassReason ??= null;
  return payload;
}

async function encodePayload(
  token: string,
  id: string,
  payload: QueuedEventPayload
): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  return encrypt(token, id, 'payload', textEncoder.encode(JSON.stringify(payload)));
}

async function reserveClientIdentity(): Promise<{
  clientSequence: number;
  clientInstallationId: string;
  clientClockSkewSeconds: number | null;
}> {
  const db = await database();
  const transaction = db.transaction(META_STORE, 'readwrite');
  const store = transaction.objectStore(META_STORE);
  const [current, installation, clockSkew] = await Promise.all([
    requestResult(store.get(NEXT_SEQUENCE_KEY) as IDBRequest<MetaRecord | undefined>),
    requestResult(store.get(INSTALLATION_ID_KEY) as IDBRequest<{ key: string; value: string } | undefined>),
    requestResult(store.get(CLOCK_SKEW_KEY) as IDBRequest<{ key: string; value: number | null } | undefined>),
  ]);
  const clientSequence = Math.max(1, current?.value ?? 1);
  const clientInstallationId = installation?.value ?? crypto.randomUUID();
  const clientClockSkewSeconds = Number.isInteger(clockSkew?.value) ? clockSkew!.value : null;
  if (!installation) store.put({ key: INSTALLATION_ID_KEY, value: clientInstallationId });
  store.put({ key: NEXT_SEQUENCE_KEY, value: clientSequence + 1 } satisfies MetaRecord);
  await transactionDone(transaction);
  return { clientSequence, clientInstallationId, clientClockSkewSeconds };
}

/** Vive exclusivamente en metadata de IndexedDB; borrar la DB crea otra instalación. */
export async function getClientInstallationId(): Promise<string> {
  const db = await database();
  const transaction = db.transaction(META_STORE, 'readwrite');
  const store = transaction.objectStore(META_STORE);
  const existing = await requestResult(
    store.get(INSTALLATION_ID_KEY) as IDBRequest<{ key: string; value: string } | undefined>
  );
  const value = existing?.value ?? crypto.randomUUID();
  if (!existing) store.put({ key: INSTALLATION_ID_KEY, value });
  await transactionDone(transaction);
  return value;
}

export async function setClockSkewSeconds(value: number | null): Promise<void> {
  if (value !== null && !Number.isInteger(value)) throw new Error('clock skew inválido');
  const db = await database();
  const transaction = db.transaction(META_STORE, 'readwrite');
  transaction.objectStore(META_STORE).put({ key: CLOCK_SKEW_KEY, value });
  await transactionDone(transaction);
}

/**
 * Persiste evento y evidencia como un solo registro IndexedDB antes de tocar la red.
 * El PIN nunca forma parte del payload. Evento y JPEG quedan cifrados con AES-GCM.
 */
export async function enqueuePunch(
  token: string,
  input: {
    employeeNumber: number;
    punchType: PunchType;
    capturedAt: string;
    photo: Blob;
    evidenceStatus?: 'captured' | 'camera_unavailable';
    clientEventId?: string;
  }
): Promise<QueuedEvent> {
  const id = input.clientEventId ?? crypto.randomUUID();
  const { clientSequence, clientInstallationId, clientClockSkewSeconds } = await reserveClientIdentity();
  const payload: QueuedEventPayload = {
    employeeNumber: input.employeeNumber,
    punchType: input.punchType,
    capturedAt: input.capturedAt,
    clientSequence,
    punchId: null,
    employeeName: null,
    punchedAtLocal: null,
    timezone: null,
    evidenceStatus: input.evidenceStatus ?? 'captured',
    clientInstallationId,
    clientClockSkewSeconds,
    identitySessionId: null,
    identityAttemptId: null,
    identityAttemptCapturedAt: null,
    identityOutcome: 'pending',
    identityBypassReason: null,
  };
  const [payloadEncrypted, photoEncrypted] = await Promise.all([
    encodePayload(token, id, payload),
    input.photo.arrayBuffer().then((bytes) => encrypt(token, id, 'photo', bytes)),
  ]);
  const now = new Date().toISOString();
  const record: StoredEvent = {
    id,
    state: 'provisional',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lastError: null,
    payloadIv: payloadEncrypted.iv,
    payloadCiphertext: payloadEncrypted.ciphertext,
    photoIv: photoEncrypted.iv,
    photoCiphertext: photoEncrypted.ciphertext,
    photoMime: input.photo.type || 'image/jpeg',
  };
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readwrite');
  transaction.objectStore(EVENTS_STORE).add(record);
  await transactionDone(transaction);
  return { id, state: record.state, createdAt: now, attempts: 0, lastError: null, payload };
}

/** Guarda la sesión dentro del payload cifrado antes de iniciar un intento. */
export async function setIdentitySession(
  token: string,
  id: string,
  identitySessionId: string
): Promise<void> {
  const db = await database();
  const read = db.transaction(EVENTS_STORE, 'readonly');
  const record = await requestResult(
    read.objectStore(EVENTS_STORE).get(id) as IDBRequest<StoredEvent | undefined>
  );
  await transactionDone(read);
  if (!record) throw new Error('La checada local ya no existe');
  const payload = await decodePayload(token, record);
  payload.identitySessionId = identitySessionId;
  const encrypted = await encodePayload(token, id, payload);
  await updateRecord(id, (current) => {
    current.payloadIv = encrypted.iv;
    current.payloadCiphertext = encrypted.ciphertext;
  });
}

/**
 * Cambia foto final + UUID de intento en una sola escritura IndexedDB. Si la
 * respuesta se pierde, ambos se conservan y ese attempt_id nunca se recrea.
 */
export async function prepareIdentityAttempt(
  token: string,
  id: string,
  input: { attemptId: string; capturedAt: string; photo: Blob; evidenceStatus: 'captured' | 'camera_unavailable' }
): Promise<void> {
  const db = await database();
  const read = db.transaction(EVENTS_STORE, 'readonly');
  const record = await requestResult(
    read.objectStore(EVENTS_STORE).get(id) as IDBRequest<StoredEvent | undefined>
  );
  await transactionDone(read);
  if (!record) throw new Error('La checada local ya no existe');
  const payload = await decodePayload(token, record);
  payload.identityAttemptId = input.attemptId;
  payload.identityAttemptCapturedAt = input.capturedAt;
  payload.evidenceStatus = input.evidenceStatus;
  const [payloadEncrypted, photoEncrypted] = await Promise.all([
    encodePayload(token, id, payload),
    input.photo.arrayBuffer().then((bytes) => encrypt(token, id, 'photo', bytes)),
  ]);
  await updateRecord(id, (current) => {
    current.payloadIv = payloadEncrypted.iv;
    current.payloadCiphertext = payloadEncrypted.ciphertext;
    current.photoIv = photoEncrypted.iv;
    current.photoCiphertext = photoEncrypted.ciphertext;
    current.photoMime = input.photo.type || 'image/jpeg';
  });
}

export async function setIdentityOutcome(
  token: string,
  id: string,
  outcome: 'verified' | 'identity_review',
  bypassReason: QueuedEventPayload['identityBypassReason'] = null
): Promise<void> {
  const db = await database();
  const read = db.transaction(EVENTS_STORE, 'readonly');
  const record = await requestResult(
    read.objectStore(EVENTS_STORE).get(id) as IDBRequest<StoredEvent | undefined>
  );
  await transactionDone(read);
  if (!record) return;
  const payload = await decodePayload(token, record);
  payload.identityOutcome = outcome;
  payload.identityBypassReason = bypassReason;
  const encrypted = await encodePayload(token, id, payload);
  await updateRecord(id, (current) => {
    current.payloadIv = encrypted.iv;
    current.payloadCiphertext = encrypted.ciphertext;
  });
}

async function allStoredEvents(): Promise<StoredEvent[]> {
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readonly');
  const records = await requestResult(transaction.objectStore(EVENTS_STORE).getAll() as IDBRequest<StoredEvent[]>);
  await transactionDone(transaction);
  return records;
}

export async function listQueuedEvents(token: string): Promise<QueuedEvent[]> {
  const records = await allStoredEvents();
  const decoded: QueuedEvent[] = [];
  for (const record of records) {
    try {
      decoded.push({
        id: record.id,
        state: record.state,
        createdAt: record.createdAt,
        attempts: record.attempts,
        lastError: record.lastError,
        payload: await decodePayload(token, record),
      });
    } catch {
      // Un registro dañado o cifrado con otra credencial queda en cuarentena;
      // jamás debe impedir que el resto de las checadas se sincronice.
      await markRejected(record.id, '[decrypt_error] Evidencia local ilegible; requiere revisión');
    }
  }
  return decoded.sort((a, b) => a.payload.clientSequence - b.payload.clientSequence);
}

export async function queueStats(): Promise<QueueStats> {
  const records = await allStoredEvents();
  return records.reduce<QueueStats>(
    (stats, record) => {
      if (record.state === 'rejected') stats.rejected += 1;
      else stats.pending += 1;
      return stats;
    },
    { pending: 0, rejected: 0 }
  );
}

async function updateRecord(id: string, mutate: (record: StoredEvent) => void): Promise<void> {
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readwrite');
  const store = transaction.objectStore(EVENTS_STORE);
  const record = await requestResult(store.get(id) as IDBRequest<StoredEvent | undefined>);
  if (record) {
    mutate(record);
    record.updatedAt = new Date().toISOString();
    store.put(record);
  }
  await transactionDone(transaction);
}

export async function markPending(id: string, error?: string): Promise<void> {
  await updateRecord(id, (record) => {
    record.state = 'pending';
    record.attempts += 1;
    record.lastError = error?.slice(0, 300) ?? null;
  });
}

export async function recoverProvisionalEvents(): Promise<void> {
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readwrite');
  const store = transaction.objectStore(EVENTS_STORE);
  const records = await requestResult(store.getAll() as IDBRequest<StoredEvent[]>);
  for (const record of records) {
    if (record.state === 'provisional') {
      record.state = 'pending';
      record.lastError = 'Recuperada después de cerrar o recargar el kiosco';
      record.updatedAt = new Date().toISOString();
      store.put(record);
    }
  }
  await transactionDone(transaction);
}

export async function acknowledgeEvent(
  token: string,
  id: string,
  acknowledgement: PunchAcknowledgement
): Promise<void> {
  const db = await database();
  const readTransaction = db.transaction(EVENTS_STORE, 'readonly');
  const record = await requestResult(
    readTransaction.objectStore(EVENTS_STORE).get(id) as IDBRequest<StoredEvent | undefined>
  );
  await transactionDone(readTransaction);
  if (!record) return;
  const payload = await decodePayload(token, record);
  payload.punchId = acknowledgement.punchId;
  payload.employeeName = acknowledgement.employeeName ?? payload.employeeName;
  payload.punchedAtLocal = acknowledgement.punchedAtLocal ?? payload.punchedAtLocal;
  payload.timezone = acknowledgement.timezone ?? payload.timezone;
  const encrypted = await encodePayload(token, id, payload);
  await updateRecord(id, (current) => {
    current.state = 'event_accepted';
    current.lastError = null;
    current.payloadIv = encrypted.iv;
    current.payloadCiphertext = encrypted.ciphertext;
  });
}

export async function markRejected(id: string, error: string): Promise<void> {
  await updateRecord(id, (record) => {
    record.state = 'rejected';
    record.attempts += 1;
    record.lastError = error.slice(0, 300);
  });
}

export async function markEvidenceError(id: string, error: string): Promise<void> {
  await updateRecord(id, (record) => {
    record.attempts += 1;
    record.lastError = error.slice(0, 300);
  });
}

/** Reintento explícito: los rechazados nunca se descartan automáticamente. */
export async function retryRejectedEvents(): Promise<void> {
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readwrite');
  const store = transaction.objectStore(EVENTS_STORE);
  const records = await requestResult(store.getAll() as IDBRequest<StoredEvent[]>);
  for (const record of records) {
    if (record.state === 'rejected') {
      record.state = 'pending';
      record.updatedAt = new Date().toISOString();
      store.put(record);
    }
  }
  await transactionDone(transaction);
}

export async function photoForEvent(token: string, id: string): Promise<Blob | null> {
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readonly');
  const record = await requestResult(
    transaction.objectStore(EVENTS_STORE).get(id) as IDBRequest<StoredEvent | undefined>
  );
  await transactionDone(transaction);
  if (!record) return null;
  const bytes = await decrypt(token, id, 'photo', record.photoIv, record.photoCiphertext);
  return new Blob([bytes], { type: record.photoMime });
}

export async function deleteQueuedEvent(id: string): Promise<void> {
  const db = await database();
  const transaction = db.transaction(EVENTS_STORE, 'readwrite');
  transaction.objectStore(EVENTS_STORE).delete(id);
  await transactionDone(transaction);
}

/** Sólo para verificar la semántica instalación↔IndexedDB en pruebas. */
export async function __resetKioskDatabaseForTests(): Promise<void> {
  const db = await database();
  db.close();
  databasePromise = null;
  keyCache.clear();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('No se pudo borrar IndexedDB de prueba'));
    request.onblocked = () => reject(new Error('IndexedDB de prueba bloqueada'));
  });
}
