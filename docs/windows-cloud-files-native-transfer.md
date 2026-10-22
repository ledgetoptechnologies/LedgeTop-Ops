# Cloud Files native transfer boundary (not activated)

`Core/CloudFilesNativeTransfer.cs` adds an internal future FETCH_DATA composition
boundary. It accepts only a verified hydration coordinator, pinned identity and a
copied `CloudFilesOperationContext`; it exposes no writable sink to callers and
accepts no path or file handle. The operation keys must originate from a trusted
callback dispatcher. They are opaque 64-bit values, including legal request key
zero. Production calls are limited to Windows x64 until other architectures have
separate qualification.

The existing coordinator performs whole-file staging, SHA-256 verification and
fresh authorization before publishing the requested aligned range. This adapter
copies each bounded chunk into owned pinned memory, creates the actual unmanaged
operation structures, calls synchronous `CfExecute`, and keeps all pointers alive
until it returns. Only `TRANSFER_DATA` is implemented. Success is committed at the
last successful native data call; subsequent cancellation cannot send a failure
for that committed range. Managed Complete does not invent another native
operation. Uncommitted failure sends one original requested range with null buffer
and a redacted Cloud Files NTSTATUS: unsuccessful (`0xC000CF12`) or caller
cancellation (`0xC000CF1B`). Native failures are not retried.

The adapter reports no verified bytes yet (total 1, completed 0)
immediately and every 20 seconds while preparation is pending. Temporary download
bytes are not called verified hydration; Windows may render this as 0%. The pump is cancelled and joined before
the final data operation or any terminal handling. Calls are serialized so no
heartbeat can outlive the operation context. Cancellation observer exceptions
cannot prevent native failure settlement. Native calls are synchronous; a native
call that does not return cannot be forcibly interrupted or safely unpinned.

Empty/zero-length callbacks, unaligned or out-of-file ranges, and mismatched file
size are explicitly unsupported. No zero-byte native completion is guessed.
This slice assumes a future compatible hydration policy without VALIDATION_REQUIRED
and less than ALWAYS_FULL; registration/policy enforcement is not implemented.
No sync-root registration, callback registration, placeholder creation, actual
hydration, pin change, Explorer integration, installation or remote write occurs.
This is not online-only/offline feature acceptance.

## ABI evidence and tests

Microsoft declarations are pinned to win32metadata commit
`2f767671802301cf043c717d66bf004ed7863487`:

- [cfapi.h](https://raw.githubusercontent.com/microsoft/win32metadata/2f767671802301cf043c717d66bf004ed7863487/generation/WinSDK/RecompiledIdlHeaders/um/cfapi.h):
  34,871 bytes, SHA-256 `9926ab4f658d2e84f10c82bb90ef8026fcfc79f16e06cbc4340106cbabae3e89`.
- [ntstatus.h](https://raw.githubusercontent.com/microsoft/win32metadata/2f767671802301cf043c717d66bf004ed7863487/generation/WinSDK/RecompiledIdlHeaders/shared/ntstatus.h):
  688,716 bytes, SHA-256 `457c375cd907d235d4f036ed9262ff9f245becf55c819bb3d1d1323c03d0195f`.

These hashes identify the exact public headers independently inspected for this
slice. No native C++ compiler/SDK ABI execution was available. Managed
`Marshal.SizeOf`/`OffsetOf` assertions and actual unmanaged-memory inspection are
not a substitute for native compiler and registered-provider qualification.

| x64 structure | Required layout |
| --- | --- |
| CF_CONNECTION_KEY | 8 bytes |
| CF_OPERATION_INFO | 48 bytes; Type 4, ConnectionKey 8, TransferKey 16, CorrelationVector 24, SyncStatus 32, RequestKey 40 |
| TransferData | 32 bytes; Flags 0, NTSTATUS 4, Buffer 8, Offset 16, Length 24 |
| CF_OPERATION_PARAMETERS | allocation 48 bytes; union at 8; **TRANSFER_DATA ParamSize 40**, not the whole union size |

Both native functions load only `CldApi.dll` from System32. Optional borrowed
CorrelationVector and SyncStatus pointers are null and never retained.

The normal `Tests/Program.cs` runner includes six new groups. They call the actual
coordinator and inspect the actual unmanaged structures and pinned byte buffers
through an injected synchronous native boundary, including forced GC, EOF tails,
post-download revocation, malformed/empty range rejection, HRESULT/exception
failure, cancellation during a call, cancellation during final successful commit,
heartbeat ordering and throwing cancellation observers. The source fixture writes
owned synthetic bytes locally; these are not live authority/network claims. There
are **zero actual CfExecute or CfReportProviderProgress host calls**. Existing
read-only platform/ordinary-file metadata tests remain separate.

Run from `apps/windows-download` with the pinned .NET SDK:

```powershell
dotnet run --project Tests/WindowsDownload.Tests.csproj
```

Primary semantics:
[operation info](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_operation_info),
[parameters and completion](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_operation_parameters),
[CfExecute](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfexecute),
[provider progress and 60-second timeout](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfreportproviderprogress).
