import { SITHook, SITHookContext, SITHookEvent } from '../types';
import { Funscript } from 'funscript-utils/lib/types';
import {
  OpaqueReason,
  OutputTransformContext,
  runOutputTransforms,
} from '../extensions';

let cache = {
  id: '',
  url: '',
};

async function uploadCsv(
  csv: File,
  filename?: string,
): Promise<{ url: string }> {
  const url = 'https://www.handyfeeling.com/api/sync/upload?local=true';
  if (!filename) filename = 'script_' + new Date().valueOf() + '.csv';
  const formData = new FormData();
  formData.append('syncFile', csv, filename);
  const response = await fetch(url, {
    method: 'post',
    body: formData,
  });
  return await response.json();
}
// Converting to CSV first instead of uploading Funscripts is required
// Reference for Funscript format:
// https://pkg.go.dev/github.com/funjack/launchcontrol/protocol/funscript
function convertFunscriptToCSV(funscript: Funscript) {
  const lineTerminator = '\r\n';
  if (funscript?.actions?.length > 0) {
    return funscript.actions.reduce((prev: string, curr) => {
      return `${prev}${curr.at},${curr.pos}${lineTerminator}`;
    }, `#Created by stash.app(SIT) ${new Date().toUTCString()}\n`);
  }
  throw new Error('Not a valid funscript');
}
async function fetchFunscript(url: string): Promise<Funscript> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not load funscript (HTTP ${response.status})`);
  return (await response.json()) as Funscript;
}
async function getHandyFeelingUrl(script: Funscript): Promise<string> {
  const csv = convertFunscriptToCSV(script);

  const fileName = `${Math.round(Math.random() * 100000000)}.csv`;
  const csvFile = new File([csv], fileName);

  return await uploadCsv(csvFile).then((response) => response.url);
}
function getJsonFileSize<T>(json: T): number {
  // Convert JSON object to string
  const jsonString = JSON.stringify(json);

  // Calculate the byte size of the JSON string
  return new Blob([jsonString]).size;
}
function transformContext(
  ctx: SITHookContext,
  generation: number | undefined,
): OutputTransformContext {
  const state = ctx.state.current;
  return {
    sceneId: state.sceneId,
    deviceId: state.device.id,
    generation: generation ?? 0,
    modifiers: state.modifiers ?? [],
  };
}
async function checkOpaque(
  ctx: SITHookContext,
  reason: OpaqueReason,
  generation?: number,
) {
  // opaque scripts cannot be transformed; transforms may still refuse them
  await runOutputTransforms(
    { kind: 'opaque', reason },
    transformContext(ctx, generation),
  );
}

export const enableHandyTokens: SITHook<SITHookEvent.RESOLVE_FUNSCRIPT_PATH> = {
  event: SITHookEvent.RESOLVE_FUNSCRIPT_PATH,
  name: 'enableHandyTokens',

  async apply(ctx, { funscriptPath, generation }) {
    const state = ctx.state.current;
    if (!cache.id || cache.id !== state.id) {
      cache = {
        id: state.id,
        url: '',
      };
    }
    let useOriginal = true;
    if (state.script && !state.ivdb && state.config.handleHandyFileTokens) {
      const script = state.script;
      const withinTokenFileSize = getJsonFileSize(script) <= 2100;
      const {
        actions: [first],
      } = script;
      const hasTokenFirstPosition = first.pos === 0 && first.at === 66;
      if (withinTokenFileSize && hasTokenFirstPosition) {
        await checkOpaque(ctx, 'handy-token', generation);
        if (cache.url) {
          funscriptPath = cache.url;
        } else {
          cache.url = funscriptPath = await getHandyFeelingUrl(script);
        }
        useOriginal = false;
      }
    }

    if (state.ivdb) {
      await checkOpaque(ctx, 'ivdb', generation);
      return { funscriptPath, appliedTransforms: [] };
    }
    if (!useOriginal) {
      return { funscriptPath, appliedTransforms: [] };
    }
    const source = await fetchFunscript(state.blobUrl || funscriptPath);
    const { script, applied } = await runOutputTransforms(
      { kind: 'actions', script: source },
      transformContext(ctx, generation),
    );
    funscriptPath = await getHandyFeelingUrl(script ?? source);
    return { funscriptPath, appliedTransforms: applied };
  },
};
