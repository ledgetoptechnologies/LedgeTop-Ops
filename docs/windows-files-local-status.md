# Local connection status

The Windows pilot may write `last-connection-status.json` inside the existing
`%LOCALAPPDATA%\LedgeTop\Files\pilot\connected-explorer-pilot-employee` directory.
It contains the last observed connection state, UTC observation time, application
version, process ID and process start time, and whether the fresh read-only folder
was active. It contains no file names, account identifiers, credentials, paths or
server responses. Writing is optional and does not control the connection.

The `freshAction` and `freshActionAtUtc` fields record the last observed fresh-folder
action in the current process: `Preparing`, `Completed`, `Failed`, `NeedsReview`,
or `Unknown` if none was observed. A crash or loss of selector ownership can leave
an earlier `Preparing` observation; it does not establish what happened afterwards.
The action observation resets to `Unknown` on a new app process and is not proof
that a previous action was never attempted.

This is a **last observation**, not a heartbeat: an old `Running` value does not
prove the app is running or connected. Check that the process ID and start time
still match the installed LedgeTop Files process, and consider the observation
timestamp. If the file is absent, invalid, or stale, its state is unknown. The
app leaves unrecognized existing status files alone.

The existing `latest-connection-failure.json` is a separate best-effort failure
record and may be older than the current application. These files are local
support evidence; they do not replace the Settings and Activity views.

The staging-only employee build may also write `last-hydration-timing.json` in the
same directory. It records one last numeric timing summary and process identity,
without URLs, file names, account identifiers, tokens or error text. It is not a
heartbeat and may be stale. The 17-element `values` array is ordered as follows:
total, context, queue, pre-authorization, cache preparation, download, cache
verification, post-authorization, native transfer, pre-token acquisition,
pre-request to response headers, post-token acquisition, post-request to response
headers (all milliseconds), then the corresponding four token/header call counts.
Header timings include network and server processing; they do not separate those
two costs. A zero count means that phase was not observed.
