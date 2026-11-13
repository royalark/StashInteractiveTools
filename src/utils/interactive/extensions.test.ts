import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Funscript } from 'funscript-utils/lib/types';
import { patchMethod } from '../interactive-api-patcher';
import { DEFAULT_PATCHES } from './patches';
import { enableHandyTokens } from './hooks';
import {
  __resetExtensionsForTests,
  extensionApi,
  installExtensionApi,
  OutputSource,
  registerOutputTransform,
  runOutputTransforms,
  SIT_EXTENSION_GLOBAL,
  SIT_EXTENSION_READY_EVENT,
  UploadEvent,
} from './extensions';
import { __resetGateForTests } from './patches/gate';
import { SITHookEvent } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// DOM/video.js helpers are not needed here
vi.mock('./utils', () => ({ getPlayerPosition: () => 0 }));

const SCRIPT: Funscript = {
  actions: [
    { at: 100, pos: 0 },
    { at: 200, pos: 25 },
    { at: 300, pos: 50 },
    { at: 400, pos: 75 },
    { at: 500, pos: 100 },
  ],
} as Funscript;

const invert = {
  id: 'invert',
  transform(source: OutputSource) {
    if (source.kind !== 'actions') throw new Error('opaque refused');
    return {
      ...source.script,
      actions: source.script.actions.map((a) => ({ at: a.at, pos: 100 - a.pos })),
    };
  },
};

function csvPositions(csv: string) {
  return csv
    .split(/\r?\n/)
    .filter((l) => /^\d/.test(l))
    .map((l) => Number(l.split(',')[1]));
}

type Harness = ReturnType<typeof createHarness>;
function createHarness(scripts: Record<string, Funscript>) {
  const uploads: string[] = [];
  const delays: Record<string, number> = {};
  let uploadCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://www.handyfeeling.com/api/sync/upload')) {
        const file = (init!.body as FormData).get('syncFile') as File;
        uploads.push(await file.text());
        return new Response(
          JSON.stringify({ url: `https://csv.test/${++uploadCount}` }),
        );
      }
      if (delays[url]) await new Promise((r) => setTimeout(r, delays[url]));
      const script = scripts[url];
      if (!script) return new Response('missing', { status: 404 });
      return new Response(JSON.stringify(script));
    }),
  );
  const device = {
    id: 'handy',
    isPlaying: false,
    isConnected: true,
    loadScript: vi.fn(async (_: { url: string }) => ({ success: true })),
    stop: vi.fn(async () => {
      device.isPlaying = false;
      return true;
    }),
    play: vi.fn(async () => {
      device.isPlaying = true;
      return true;
    }),
    syncTime: vi.fn(),
    getConfig: () => ({}),
  };
  const api: any = {
    uploadScript: async () => {},
    play: async () => {},
    ensurePlaying: async () => {},
    pause: async () => {},
    connect: async () => {},
    sync: async () => 0,
    set scriptOffset(_v: number) {},
    _handy: { setHsspStop: vi.fn(async () => {}) },
  };
  const state = {
    current: {
      id: '',
      sceneId: '1',
      ivdb: false,
      script: null as Funscript | null,
      blobUrl: null as string | null,
      hooks: [enableHandyTokens],
      device,
      modifiers: [],
      config: { handleHandyFileTokens: true } as any,
    },
  };
  const ctx: any = { api, state };
  const dispatcher = async (event: SITHookEvent, payload: any) => {
    let acc = payload;
    for (const hook of ctx.state.current.hooks) {
      acc = { ...acc, ...(await hook.apply({ ...ctx, logger: console }, acc)) };
    }
    return acc;
  };
  DEFAULT_PATCHES.forEach((p) => patchMethod(ctx, p as any, dispatcher as any));
  return { api, ctx, state, device, uploads, delays };
}

let events: UploadEvent[];
beforeEach(() => {
  __resetExtensionsForTests();
  __resetGateForTests();
  events = [];
  extensionApi.subscribe((e) => events.push(e));
});
afterEach(() => vi.unstubAllGlobals());

describe('runOutputTransforms', () => {
  it('gives each transform a copy and never mutates the source', async () => {
    const source = structuredClone(SCRIPT);
    registerOutputTransform({
      id: 'mutator',
      transform(s) {
        if (s.kind === 'actions') s.script.actions[0].pos = 42;
      },
    });
    const { script, applied } = await runOutputTransforms(
      { kind: 'actions', script: source },
      { sceneId: '1', deviceId: 'handy', generation: 1, modifiers: [] },
    );
    expect(source).toEqual(SCRIPT);
    expect(script).toBe(source); // returned nothing -> unchanged
    expect(applied).toEqual([]);
  });

  it('wraps a throwing transform with its id', async () => {
    registerOutputTransform({
      id: 'boom',
      transform() {
        throw new Error('nope');
      },
    });
    await expect(
      runOutputTransforms(
        { kind: 'opaque', reason: 'ivdb' },
        { sceneId: '1', deviceId: 'handy', generation: 1, modifiers: [] },
      ),
    ).rejects.toMatchObject({ transformId: 'boom', message: 'nope' });
  });

  it('unregister removes the transform', async () => {
    const off = registerOutputTransform(invert);
    off();
    const { applied } = await runOutputTransforms(
      { kind: 'actions', script: SCRIPT },
      { sceneId: '1', deviceId: 'handy', generation: 1, modifiers: [] },
    );
    expect(applied).toEqual([]);
  });
});

describe('installExtensionApi', () => {
  it('exposes the api on window and fires the ready event', () => {
    const win = new EventTarget() as any;
    const ready = vi.fn();
    win.addEventListener(SIT_EXTENSION_READY_EVENT, (e: CustomEvent) =>
      ready(e.detail),
    );
    installExtensionApi(win);
    expect(win[SIT_EXTENSION_GLOBAL].apiVersion).toBe(1);
    expect(ready).toHaveBeenCalledWith(win[SIT_EXTENSION_GLOBAL]);
  });
});

describe('patched uploadScript', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ 'blob:a': SCRIPT, 'blob:b': SCRIPT });
    h.state.current.blobUrl = 'blob:a';
    h.state.current.script = SCRIPT;
  });

  it('sends the script unchanged when no transform is registered', async () => {
    await h.api.uploadScript('blob:a');
    expect(csvPositions(h.uploads[0])).toEqual([0, 25, 50, 75, 100]);
    expect(h.device.loadScript).toHaveBeenCalledWith({
      url: 'https://csv.test/1',
      type: 'funscript',
    });
  });

  it('applies the transform exactly once per upload, also on re-upload', async () => {
    registerOutputTransform(invert);
    await h.api.uploadScript('blob:a');
    await h.api.uploadScript('blob:a');
    await h.api.uploadScript('blob:a');
    for (const csv of h.uploads)
      expect(csvPositions(csv)).toEqual([100, 75, 50, 25, 0]);
    const success = events.filter((e) => e.type === 'upload-success');
    expect(success.at(-1)).toMatchObject({ appliedTransforms: ['invert'] });
  });

  it('keeps timestamps and action count', async () => {
    registerOutputTransform(invert);
    await h.api.uploadScript('blob:a');
    const ats = h.uploads[0]
      .split(/\r?\n/)
      .filter((l) => /^\d/.test(l))
      .map((l) => Number(l.split(',')[0]));
    expect(ats).toEqual([100, 200, 300, 400, 500]);
  });

  it('blocks: nothing is loaded, device stops, playback refused', async () => {
    registerOutputTransform({
      id: 'invert',
      transform() {
        throw new Error('invalid script');
      },
    });
    h.device.isPlaying = true;
    await expect(h.api.uploadScript('blob:a')).rejects.toThrow('invalid script');
    expect(h.uploads).toHaveLength(0);
    expect(h.device.loadScript).not.toHaveBeenCalled();
    expect(h.device.stop).toHaveBeenCalled();

    await h.api.play(1);
    await h.api.ensurePlaying(1);
    await h.api.ensurePlaying(2);
    expect(h.device.play).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual([
      'upload-start',
      'upload-failed',
      'play-blocked', // explicit play; repeated ensurePlaying is deduped
    ]);
    expect(extensionApi.getState().blocked).toMatchObject({
      transformId: 'invert',
    });
  });

  it('a later successful upload clears the block', async () => {
    let fail = true;
    registerOutputTransform({
      id: 'flaky',
      transform() {
        if (fail) throw new Error('x');
      },
    });
    await expect(h.api.uploadScript('blob:a')).rejects.toThrow();
    fail = false;
    await h.api.uploadScript('blob:a');
    await h.api.play(1);
    expect(h.device.play).toHaveBeenCalledTimes(1);
    expect(extensionApi.getState().blocked).toBeNull();
  });

  it('a slow older upload never overwrites a newer one', async () => {
    registerOutputTransform(invert);
    h.delays['blob:a'] = 30;
    h.state.current.blobUrl = null; // use the path argument
    const first = h.api.uploadScript('blob:a');
    const second = h.api.uploadScript('blob:b');
    await Promise.all([first, second]);
    expect(h.device.loadScript).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual([
      'upload-superseded',
      'upload-start',
      'upload-success',
    ]);
  });

  it('refuses playback while an upload is pending', async () => {
    h.delays['blob:a'] = 20;
    const pending = h.api.uploadScript('blob:a');
    await h.api.play(1);
    expect(h.device.play).not.toHaveBeenCalled();
    await pending;
    await h.api.play(1);
    expect(h.device.play).toHaveBeenCalledTimes(1);
  });
});

describe('opaque scripts', () => {
  const TOKEN = { actions: [{ at: 66, pos: 0 }, { at: 99, pos: 0 }] } as Funscript;

  it('handy token: a refusing transform blocks it', async () => {
    const h = createHarness({ 'blob:t': TOKEN });
    h.state.current.script = TOKEN;
    h.state.current.blobUrl = 'blob:t';
    registerOutputTransform(invert);
    await expect(h.api.uploadScript('blob:t')).rejects.toThrow('opaque refused');
    expect(h.uploads).toHaveLength(0);
  });

  it('handy token: passes through untouched without a refusing transform', async () => {
    const h = createHarness({ 'blob:t': TOKEN });
    h.state.current.script = TOKEN;
    h.state.current.blobUrl = 'blob:t';
    registerOutputTransform({ id: 'noop', transform() {} });
    await h.api.uploadScript('blob:t');
    expect(csvPositions(h.uploads[0])).toEqual([0, 0]);
  });

  it('ivdb: a refusing transform blocks it', async () => {
    const h = createHarness({});
    h.state.current.ivdb = true;
    registerOutputTransform(invert);
    await expect(h.api.uploadScript('https://ivdb.test/x')).rejects.toThrow();
    expect(h.device.loadScript).not.toHaveBeenCalled();
  });
});
