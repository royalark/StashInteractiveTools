import { PatchContext, withPatcher } from '../types';
import { getPlayerPosition } from '../utils';
import { emitUploadEvent } from '../extensions';
import { isPlaybackGated, uploadGate } from './gate';

/**
 * Refuse to start the device while the loaded script is stale (a newer upload
 * is pending) or the last upload failed - otherwise the device would play
 * whatever script it still holds.
 */
let notifiedBlock: object | null = null;
async function refusePlayback(
  ctx: PatchContext<'play'> | PatchContext<'ensurePlaying'>,
  explicit: boolean,
) {
  if (!isPlaybackGated()) return false;
  const { sceneId } = ctx.state.current;
  const block = uploadGate.blocked;
  // ensurePlaying is called repeatedly by the player; notify once per block
  if (block && (explicit || notifiedBlock !== block)) {
    notifiedBlock = block;
    emitUploadEvent({ type: 'play-blocked', sceneId, ...block });
  }
  ctx.logger.debug('playback gated', uploadGate);
  await stopDevice(ctx);
  return true;
}

/**
 * Stop the device even if this provider's device wrapper has not loaded a
 * script yet (its stop() is a no-op then, but the Handy may still be running).
 */
export async function stopDevice(ctx: {
  api: PatchContext<'pause'>['api'];
  state: PatchContext<'pause'>['state'];
  logger: PatchContext<'pause'>['logger'];
}) {
  const { device } = ctx.state.current;
  try {
    if (device.isConnected) {
      await device.stop();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.api as any)._handy?.setHsspStop?.();
    }
  } catch (e) {
    ctx.logger.error('failed to stop device', e);
  }
}

export const connectPatcher = withPatcher('connect', (ctx) => {
  ctx.value(async function connect() {
    const {
      api,
      logger,
      state: {
        current: { device },
      },
    } = ctx;

    logger.debug('connect');
    if (device.id === 'handy') {
      await device.connect({
        connectionKey: api.handyKey,
      });
    } else {
      await device.connect();
    }
  });
});

export const scriptOffsetPatcher = withPatcher('scriptOffset', (ctx) => {
  ctx.set((value: number) => {
    const device = ctx.state.current.device;
    const config = device.getConfig();
    if ('offset' in config) {
      config.offset = value;
    }
    return value;
  });
});

export const syncPatcher = withPatcher('sync', (ctx) => {
  ctx.value(async function sync() {
    const {
      api,
      state: {
        current: { device },
      },
    } = ctx;

    const timeMs = (getPlayerPosition() ?? 0) * 1000;
    await device.syncTime(timeMs);

    return api._handy.estimatedServerTimeOffset;
  });
});

export const pausePatcher = withPatcher('pause', (ctx) => {
  ctx.value(async function pause() {
    const {
      state: {
        current: { device },
      },
    } = ctx;

    await device.stop();
  });
});

export const ensurePlayingPatcher = withPatcher('ensurePlaying', (ctx) => {
  ctx.value(async function ensurePlaying(position: number) {
    const {
      state: {
        current: { device },
      },
    } = ctx;
    ctx.logger.debug('ensurePlaying', position, device.isPlaying);
    if (await refusePlayback(ctx, false)) return;
    if (device.isPlaying) {
      return;
    }

    await device.play(position);
  });
});

export const playPatcher = withPatcher('play', (ctx) => {
  ctx.value(async function play(position: number) {
    const {
      state: {
        current: { device },
      },
    } = ctx;
    ctx.logger.debug('play', position, device.isPlaying);
    if (await refusePlayback(ctx, true)) return;

    await device.play(position);
  });
});
