import { UploadBlock } from '../extensions';

/**
 * Device-level upload/playback gate shared by the patched methods.
 * Lives at module level (not in a provider's state) because the patched
 * interactive client outlives any single scene page.
 */
export const uploadGate = {
  /** incremented on every uploadScript call */
  generation: 0,
  /** generation of the script currently loaded on the device (0 = none yet) */
  loadedGeneration: 0,
  /** set when the latest upload failed; playback is refused until cleared */
  blocked: null as UploadBlock | null,
};

/** true while the device must not play: last upload failed or a newer one is pending */
export function isPlaybackGated() {
  return (
    uploadGate.blocked !== null ||
    uploadGate.generation !== uploadGate.loadedGeneration
  );
}

export function __resetGateForTests() {
  uploadGate.generation = 0;
  uploadGate.loadedGeneration = 0;
  uploadGate.blocked = null;
}
