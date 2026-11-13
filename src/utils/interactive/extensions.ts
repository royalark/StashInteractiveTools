/**
 * Public extension API for other Stash UI plugins.
 *
 * Other plugins discover it through `window.StashInteractiveTools` (or the
 * `stash-interactive-tools:ready` window event) and can register *output
 * transforms*: functions that see the final funscript right before SIT turns it
 * into the CSV that is sent to the device. See docs/extensions.md.
 *
 * Guarantees:
 *  - transforms run on every device upload, always on a fresh copy of the
 *    final (post-pipeline) script, so re-uploads can never stack a transform;
 *  - a throwing transform blocks the upload: SIT stops the device and refuses
 *    to play until the next successful upload (nothing un-transformed is sent);
 *  - scripts whose content SIT cannot see (Handy tokens, ivdb) are reported as
 *    `opaque` so a transform can refuse them.
 */
import { Funscript } from 'funscript-utils/lib/types';

export const SIT_EXTENSION_API_VERSION = 1;
export const SIT_EXTENSION_GLOBAL = 'StashInteractiveTools';
export const SIT_EXTENSION_READY_EVENT = 'stash-interactive-tools:ready';

export type OpaqueReason = 'handy-token' | 'ivdb';

export type OutputSource =
  | { kind: 'actions'; script: Funscript }
  | { kind: 'opaque'; reason: OpaqueReason };

export type OutputModifierSummary = {
  id: string;
  values: Record<string, unknown>;
};

export type OutputTransformContext = {
  sceneId: string;
  deviceId: string;
  generation: number;
  /** Modifiers of the active SIT modification pipeline (e.g. a Custom preset). */
  modifiers: OutputModifierSummary[];
};

export type OutputTransform = {
  id: string;
  /**
   * Return the script to send (or nothing to leave it unchanged).
   * Throw to block the upload. For `opaque` sources the return value is
   * ignored; throwing still blocks.
   */
  transform(
    source: OutputSource,
    ctx: OutputTransformContext,
  ): Funscript | void | Promise<Funscript | void>;
};

export type UploadBlock = { message: string; transformId?: string };

export type UploadEvent =
  | { type: 'upload-start'; sceneId: string; generation: number }
  | {
      type: 'upload-success';
      sceneId: string;
      generation: number;
      appliedTransforms: string[];
    }
  | { type: 'upload-superseded'; sceneId: string; generation: number }
  | ({
      type: 'upload-failed';
      sceneId: string;
      generation: number;
    } & UploadBlock)
  | ({ type: 'play-blocked'; sceneId: string } & UploadBlock);

export type ExtensionState = {
  activeSceneId: string | null;
  blocked: UploadBlock | null;
  lastAppliedTransforms: string[];
};

export interface SITExtensionApi {
  readonly apiVersion: number;
  registerOutputTransform(transform: OutputTransform): () => void;
  /** Stop the device and upload the active scene's script again. */
  reupload(reason?: string): Promise<void>;
  subscribe(listener: (event: UploadEvent) => void): () => void;
  getState(): ExtensionState;
}

export class OutputTransformError extends Error {
  constructor(
    public readonly transformId: string,
    message: string,
  ) {
    super(message);
    this.name = 'OutputTransformError';
  }
}

type ActiveSession = {
  sceneId: string;
  reupload: (reason?: string) => Promise<void>;
};

const transforms = new Map<string, OutputTransform>();
const listeners = new Set<(event: UploadEvent) => void>();
let activeSession: ActiveSession | null = null;
let blocked: UploadBlock | null = null;
let lastAppliedTransforms: string[] = [];

function cloneScript(script: Funscript): Funscript {
  return typeof structuredClone === 'function'
    ? structuredClone(script)
    : JSON.parse(JSON.stringify(script));
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function registerOutputTransform(transform: OutputTransform) {
  if (!transform || typeof transform.transform !== 'function' || !transform.id)
    throw new Error('Invalid output transform');
  transforms.set(transform.id, transform);
  return () => {
    if (transforms.get(transform.id) === transform)
      transforms.delete(transform.id);
  };
}

export async function runOutputTransforms(
  source: OutputSource,
  ctx: OutputTransformContext,
): Promise<{ script?: Funscript; applied: string[] }> {
  const applied: string[] = [];
  let current = source.kind === 'actions' ? source.script : undefined;
  for (const t of transforms.values()) {
    let out: Funscript | void;
    try {
      out = await t.transform(
        current
          ? { kind: 'actions', script: cloneScript(current) }
          : (source as OutputSource),
        { ...ctx, modifiers: ctx.modifiers.map((m) => ({ ...m })) },
      );
    } catch (e) {
      throw new OutputTransformError(t.id, errorMessage(e));
    }
    if (current && out) {
      if (!Array.isArray(out.actions))
        throw new OutputTransformError(t.id, 'transform returned no actions');
      current = out;
      applied.push(t.id);
    }
  }
  return { script: current, applied };
}

export function emitUploadEvent(event: UploadEvent) {
  if (event.type === 'upload-success') {
    blocked = null;
    lastAppliedTransforms = event.appliedTransforms;
  } else if (event.type === 'upload-failed') {
    blocked = { message: event.message, transformId: event.transformId };
  }
  listeners.forEach((l) => {
    try {
      l(event);
    } catch (e) {
      console.error('[StashInteractiveTools] extension listener failed', e);
    }
  });
}

export function setActiveSession(session: ActiveSession) {
  activeSession = session;
  return () => {
    if (activeSession === session) activeSession = null;
  };
}

export function toUploadBlock(e: unknown): UploadBlock {
  return e instanceof OutputTransformError
    ? { message: e.message, transformId: e.transformId }
    : { message: errorMessage(e) };
}

export const extensionApi: SITExtensionApi = Object.freeze({
  apiVersion: SIT_EXTENSION_API_VERSION,
  registerOutputTransform,
  subscribe(listener: (event: UploadEvent) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async reupload(reason?: string) {
    if (!activeSession) return;
    await activeSession.reupload(reason);
  },
  getState: (): ExtensionState => ({
    activeSceneId: activeSession?.sceneId ?? null,
    blocked,
    lastAppliedTransforms,
  }),
});

export function installExtensionApi(win: Window = window) {
  const w = win as unknown as Record<string, unknown>;
  if (w[SIT_EXTENSION_GLOBAL]) return;
  Object.defineProperty(w, SIT_EXTENSION_GLOBAL, {
    value: extensionApi,
    configurable: true,
  });
  win.dispatchEvent(
    new CustomEvent(SIT_EXTENSION_READY_EVENT, { detail: extensionApi }),
  );
}

/** test helper */
export function __resetExtensionsForTests() {
  transforms.clear();
  listeners.clear();
  activeSession = null;
  blocked = null;
  lastAppliedTransforms = [];
}
