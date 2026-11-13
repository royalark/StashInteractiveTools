# Extension API (apiVersion 1)

Other Stash UI plugins can change what StashInteractiveTools (SIT) sends to the
device without forking SIT. The API covers one narrow need: **transform the
final script right before it becomes the CSV that is uploaded to the device**,
or refuse to send it.

## Why an extension point

The script SIT sends is not reachable from outside:

- SIT replaces `uploadScript` on Stash's interactive client with
  `Object.defineProperty`, so wrapping the client through
  `InteractiveUtils.interactiveClientProvider` cannot change SIT's upload.
- SIT's upload reads the script from its private state
  (`state.blobUrl || funscriptPath`), so passing a different path is ignored.
- CSV conversion and the upload are module-private; the only shared point is
  global `fetch`, which an extension should not hook.

## Discovery

```js
function onSit(api) {
  if (api.apiVersion < 1) return;
  api.registerOutputTransform(myTransform);
}
if (window.StashInteractiveTools) onSit(window.StashInteractiveTools);
window.addEventListener('stash-interactive-tools:ready', (e) => onSit(e.detail));
```

Stash loads every plugin script before rendering, so either load order works.
Add `ui.requires: [StashInteractiveTools]` if your plugin also patches the
same components as SIT.

## Output transforms

```ts
registerOutputTransform({
  id: 'my-transform',
  transform(source, ctx) {
    // source: { kind: 'actions', script }            -> return a script (or nothing)
    //       | { kind: 'opaque', reason: 'handy-token' | 'ivdb' }
    // ctx: { sceneId, deviceId, generation, modifiers: [{ id, values }] }
  },
}); // returns an unregister function
```

Guarantees:

| Guarantee | Detail |
|---|---|
| Runs on every device upload | including re-uploads and script switches |
| Fresh input | each call gets a deep copy of the final post-pipeline script, so a transform can never be applied twice to the same data |
| Ordering | transforms run in registration order, each on the previous one's output |
| Opaque sources | Handy token scripts and ivdb scripts have no visible content; they are passed as `opaque` so a transform can refuse them (throw). The return value is ignored |
| Fail closed | if a transform throws, nothing is uploaded, SIT stops the device and refuses `play`/`ensurePlaying` until the next successful upload |

## Upload serialisation and playback gate

Uploads are serialised. Each call gets a generation number. An upload that has
been superseded by a newer call is skipped, so it never reaches the device.
While an upload is pending, or after one failed, `play` and `ensurePlaying` do
not start the device. Without this gate, the device would play whatever script
it still held, possibly the previous scene's.

## Other API

```ts
api.reupload(reason?)  // stop the device and upload the active scene's script again
api.subscribe(listener) // upload-start | upload-success{appliedTransforms} |
                        // upload-superseded | upload-failed{message,transformId} |
                        // play-blocked{message}
api.getState()          // { activeSceneId, blocked, lastAppliedTransforms }
```

## Also changed

`ScenePage.Tabs` and `ScenePage.TabContent` `after` patches now build on the
previous patch's output (the last argument Stash passes) instead of
`props.children`, so tabs added by other plugins are no longer dropped.
