# Adoption source retention candidate

This candidate copies server-folder imports and retains original source trees.
Deferred cleanup and ambiguous legacy recovery are held for review. Interrupted
copies can consume storage and require intervention; capacity and a recovery
workflow must be qualified before release.

Promotion still uses a separate destination check and rename. A concurrent
writer can create an empty destination in that interval and have it replaced.
The candidate is not production-ready until promotion is fenced or uses a
qualified atomic no-replace operation and the prior writer generation is
drained. The upload-cache cleanup and late-writer races are separate open gates.
