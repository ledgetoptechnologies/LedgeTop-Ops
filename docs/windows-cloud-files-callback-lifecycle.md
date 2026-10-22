# Cloud Files callback lifecycle rehearsal

The internal `CloudFilesCallbackDispatcher` prepares request ownership and drain
semantics for a future registered provider. It registers no callbacks or sync
root, connects no provider, starts no browser sign-in and performs no native
transfer itself. Its only byte-producing path is an internally injected trusted
hydrator that invokes the existing verified hydration coordinator. There is no
callback-controlled factory, URL or raw writable sink API.

The native adapter owns `CloudFilesOperationContext`: copied opaque connection,
transfer and request keys plus file size and required range. No callback pointer,
borrowed string, correlation pointer or OS handle is retained. This dispatcher
copies at most4096 identity bytes synchronously, decodes the exact immutable
identity and matches channel, fixed source alias/origin and opaque principal to
the trusted registration context. Callback file size must equal its pinned
length. `RequiredLength=-1` is normalized to bounded EOF. Zero-length requests,
unaligned offsets and non-EOF unaligned lengths are explicitly unsupported.

Requests are keyed by connection/transfer/request together. Exact active duplicate
callbacks get the same completion task; conflicting identity/range metadata for
an active key is rejected. After the trusted native hydrator and its keepalive
fully join, the request is retired and its completion is signaled under the same
lock. A later callback can reuse opaque keys (including RequestKey zero) for a
new range and must obtain fresh authorization. The bounded map limits only
in-flight work (default256); it does not permanently exhaust a connection after
256 completed callbacks. Shutdown snapshots still include all undrained work.
Cancellation signals only the exact matching request and waits for its tracked
operation to drain. Cancellation callbacks run outside the dispatcher lock. Their single tracked
`CancelAsync` task must settle before request CTS disposal or retirement. A
blocked cancellation-observer regression verifies operation and Stop remain
pending until that observer releases. Trusted token observers must not wait for
their own request completion or Stop, which would create a self-deadlock; the
native adapter must use non-reentrant cancellation observers.
Cancellation of one request does not cancel another request sharing a transfer
key. The first unregistered slice supports only cancellation of the entire
normalized requested range. Native cancellation **may specify a subset**; this
returns `UnsupportedRange`, preserves still-needed bytes and performs no whole-
request cancellation. Interval-aware cancellation remains required before native
callback registration. The result must not be silently treated as a successful
native cancellation.

Stop rejects new fetches, cancels existing work and awaits all tracked hydrations
before disposing coordinator resources and request cancellation sources. Repeated
Stop/Dispose joins the same drain. A caller may cancel its wait without aborting
the underlying cleanup or falsely declaring the work drained. If a trusted source
ignores cancellation, drain remains pending; the dispatcher does not free native
context underneath running work or pretend a timeout completed cleanup.

The native hydrator composition must own its provider-progress keepalive at less
than60seconds during potentially lengthy whole-file download and hashing, then
stop and join it before native terminal operations and before returning. The
native adapter uses a sub20second interval and truthful indeterminate progress;
this dispatcher awaits that entire lifetime rather than starting a second timer.
It must not report verified completion early. This source slice is not a proof
that an actual registered callback survives a long download.

Rejected identities/contexts throw before entering the native hydrator. A future
unmanaged callback trampoline **must catch and explicitly fail that native
request** rather than let exceptions cross the ABI or leave it hanging. No such
trampoline/registration is implemented. Native TRANSFER_DATA terminal semantics
belong to the native sink; the managed Complete method is not a separate invented
native completion operation.

## Verification

The seven added callback groups use the actual hydration coordinator and
Downloader, temporary owned cache, SHA verification and asynchronous recording
sinks. The composed positive path invokes the actual managed native-transfer adapter
against a fake native boundary and checks marshalled buffer contents; it makes no
real CfExecute call. They check copied-buffer independence, shared active duplicate task, completed
key reuse with a different range, malformed/foreign identity and context, conflicting key data,
normalized EOF, zero-length/range refusal, revoked cached reuse, active bounds and more sequential requests than the configured bound,
redacted failures, exact-key cancellation while another request remains valid,
subset cancellation refusal, and stop waiting for delayed terminal/keepalive
cleanup. These are source-level lifecycle tests, not registered callback,
Explorer, pinning, offline-open or installed-user acceptance.

The test command uses pinned.NET10.0.402:

```
dotnet run --project apps/windows-download/Tests/WindowsDownload.Tests.csproj -c Release
```

Official constraints:

- [FETCH_DATA callback parameters](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_callback_parameters)
- [Provider progress timeout reset](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfreportproviderprogress)
- [Transfer-data completion and alignment](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_operation_parameters)
