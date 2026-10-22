# Obj2Tiles production fork patch

The Viewer builds Obj2Tiles from the official OpenDroneMap `v1.6.2` source archive. The Docker build verifies the archive SHA-256 before applying `v1.6.2-bounded-concurrency.patch` with fuzz disabled. Architecture-specific NuGet lock sets under `locks/` were generated from that pinned source with .NET SDK 10.0.203 and are restored in locked mode before a no-restore publish. It emits `build-info.json` binding the source, patch, version, and resulting binary digest; runtime policy and published-image CI both verify that contract and CI independently re-hashes the executable.

The patch changes scheduling and diagnostics only:

- LODs run sequentially and outer tile conversion and writing are explicitly bounded;
- the production command uses at most two outer workers and one ImageSharp worker per image;
- when any stage fails for explicit scheduler or memory pressure, the worker removes only its lease-token-scoped incomplete tree and retries the whole conversion exactly once at one outer/image worker;
- diagnostics contain exception type/HRESULT and aggregate process, GC, thread-pool, and cgroup counters, but no source or output paths.

The upstream source is AGPL-3.0. The resulting image retains upstream `LICENSE.md` beside the executable. Source restore and compilation happen only in the image build stage; the runtime image contains no SDK and needs no network. Any source, dependency, SDK, or patch update must also update the lock sets and pinned hashes in the Dockerfile, runtime policy, published-image CI, runtime smoke test, and controlled command provenance.
