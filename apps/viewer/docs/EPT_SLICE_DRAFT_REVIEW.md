# EPT slice candidate: draft review only

This candidate is **default off and not release ready**. It does not apply its
Potree patch in the production Dockerfile, publish an image, or enable the
feature. The marked bundle is created in memory by synthetic preview helpers.

The full-parent browser test depends on the detached-iframe measurement listener
fix. That fix is not in this candidate. Coordinate its separate review and the
overlapping measurement work in PR #492, then rebase on the verified resulting
main commit before treating the full-parent test as evidence for this tree.
The model rail work in PR #496 also overlaps Viewer files and needs a deliberate
merge and recheck. Do not infer either dependency has landed from this note.

The build patch verifies the exact original, intermediate and marked output
hashes. Its expected input was observed in a local Viewer image after the
existing EPT patch; a fresh build has not established that its corresponding
bytes match. A reviewed build integration, asset compatibility checks and
staging qualification are still required before activation.

The browser tests are intentionally opt-in. If enabled, missing prerequisites
fail rather than silently skip. Set these environment variables locally:

- `RUN_EPT_SLICE_BROWSER=1`.
- `EDGE_PATH`: absolute path to a compatible Chromium/Edge executable.
- `VIEWER_EPT_IMAGE`: local Viewer image tag whose exact SHA is asserted in
  the tests. The image must contain the pinned Potree bundle in `/app/dist`.
- `VIEWER_EPT_NODE_MODULES`: absolute path to a pre-existing Viewer dependency
  tree containing Vite, required only by the full-parent test. Its Vite cache
  is created in a temporary directory; the dependency tree is not modified.

Run one browser suite at a time, coordinate other sessions, and use the existing
browser lock. The harness uses only synthetic EPT data, a loopback-bound fixture,
bounded container resources, and a read-only candidate mount. It removes its
own browser, temporary profile and container. A skip is not acceptance evidence.

The CPU culling diagnostic can be run with the reviewed local image and this
checkout's `apps/viewer` mounted read-only at `/candidate`, using `node
/candidate/test/helpers/potree-cull-candidate-check.mjs`, with network disabled
and bounded CPU/memory. The helper checks exact bundle hashes and independently
tests contained, crossing, outside, reflected, multiple-box and singular cases.

Synthetic picking and mocked sessions do not establish real-client access,
visual/EDL accuracy, all streamed-node transforms, live renewal, source profile
and volume persistence, or large-cloud performance. Those remain open release
checks; the compatibility marker is not authentication or runtime integrity.
