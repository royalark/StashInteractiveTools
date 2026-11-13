import { SITHookEvent, withPatcher } from '../types';
import { emitUploadEvent, toUploadBlock } from '../extensions';
import { uploadGate } from './gate';
import { stopDevice } from './common';

export const uploadScriptPatcher = withPatcher(
  'uploadScript',
  (ctx, dispatcher) => {
    // uploads are serialized so an older, slower upload can never finish
    // after (and overwrite) a newer one on the device.
    let queue: Promise<unknown> = Promise.resolve();

    ctx.value(function uploadScript(funscriptPath: string, apiKey?: string) {
      const generation = ++uploadGate.generation;

      const run = async () => {
        const state = ctx.state.current;
        const sceneId = state.sceneId;
        if (generation !== uploadGate.generation) {
          emitUploadEvent({ type: 'upload-superseded', sceneId, generation });
          return;
        }
        emitUploadEvent({ type: 'upload-start', sceneId, generation });
        try {
          const { funscriptPath: url, appliedTransforms = [] } =
            await dispatcher(SITHookEvent.RESOLVE_FUNSCRIPT_PATH, {
              funscriptPath,
              apiKey,
              generation,
            });
          if (generation !== uploadGate.generation) {
            emitUploadEvent({ type: 'upload-superseded', sceneId, generation });
            return;
          }
          await state.device.loadScript({
            url,
            type: 'funscript',
          });
          uploadGate.loadedGeneration = generation;
          uploadGate.blocked = null;
          emitUploadEvent({
            type: 'upload-success',
            sceneId,
            generation,
            appliedTransforms,
          });
        } catch (e) {
          const block = toUploadBlock(e);
          uploadGate.blocked = block;
          await stopDevice(ctx);
          emitUploadEvent({
            type: 'upload-failed',
            sceneId,
            generation,
            ...block,
          });
          throw e;
        }
      };

      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    });
  },
);
