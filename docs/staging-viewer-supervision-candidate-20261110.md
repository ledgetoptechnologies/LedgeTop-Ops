# Staging Viewer supervision candidate

For the later installed state and observed restart results, see
[the verification checkpoint](staging-viewer-candidate/verified-state-20261110.md).
The design history below includes earlier blockers and provisional commands.

Status: **design candidate, not installable or approved for execution**. This
describes a concrete service split for the existing `.90` Viewer. It does not
authorize a restart, network change, image update, or storage access.

## Proposed Compose override

The following would be added as a separate override after the current base and
UI-acceptance overrides. The image digest is the Processing owner's reported
`80bb4be0` manifest and must be independently checked against the target
architecture and deployed source before use. The dedicated CIFS and local data
mounts, users, container guard, resource limits, proxy, and log limits remain
inherited from the existing base. The proposed database bind below points to a
new, not-yet-created local path and does not replace or migrate the old database.

**Database compatibility blocker, November 10:** the Processing owner inspected
the stopped staging database read-only and reported an intact SQLite quick check
but conflicting migration identities: installed versions 39 through 41 are
`viewer_account_navigation_preferences`, `durable_processing_dispatch_order`,
and `provider_health_diagnostic_codes`; the proposed image uses those numbers
for different migrations. Do not
start the proposed image against that database. Independently verify source and
schema identities and design a reviewed data-preserving migration, or qualify a
separate isolated staging database without altering the existing one. The mount
inheritance described here is therefore not a safe executable configuration.
The Processing owner also reports the base Compose image tag and historical
CIFS-seal image are absent from the local image inventory. Do not assume the
original rollback image is available; independently locate and verify the exact
artifact before any change that could need it.

```yaml
services:
  viewer-proxy:
    image: nginx@sha256:697b0b156c70b91130853fd0675c6be36665939d5f93dce2686be04b4c3f98a8
  viewer-api:
    image: ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@sha256:5b78e6122467968e617932a4d4a19388db7dac576449acb4bf1c790f723170c5
    volumes:
      - type: bind
        source: /var/lib/ledgetop-viewer-photo-staging/db
        target: /app/storage/data
        bind:
          create_host_path: false
      - type: bind
        source: /var/lib/ledgetop-viewer-photo-staging/coordinator-ca.crt
        target: /run/processing-trust/ca.crt
        read_only: true
        bind:
          create_host_path: false
    environment:
      DATABASE_PATH: /app/storage/data/viewer.sqlite
      NODE_EXTRA_CA_CERTS: /run/processing-trust/ca.crt
      PROCESSING_PLATFORM_ENABLED: "true"
      PROCESSING_WORKER_ENABLED: "false"
      LOCAL_DERIVATIVES_ENABLED: "false"
      MESH_DERIVATIVES_ENABLED: "true"
      CLIENT_VIEWER_SHARES_ENABLED: "false"
      VIEWER_REFERENCE_ACCEPTANCE_ENABLED: "false"
      VIEWER_REFERENCE_SOURCE_INTAKE_ENABLED: "false"
      VIEWER_SOURCE_RELEASE_ENABLED: "false"
  viewer-worker:
    image: ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@sha256:5b78e6122467968e617932a4d4a19388db7dac576449acb4bf1c790f723170c5
    profiles: ["viewer-processing-held"]
    volumes:
      - type: bind
        source: /var/lib/ledgetop-viewer-photo-staging/db
        target: /app/storage/data
        bind:
          create_host_path: false
      - type: bind
        source: /var/lib/ledgetop-viewer-photo-staging/coordinator-ca.crt
        target: /run/processing-trust/ca.crt
        read_only: true
        bind:
          create_host_path: false
    environment:
      DATABASE_PATH: /app/storage/data/viewer.sqlite
      NODE_EXTRA_CA_CERTS: /run/processing-trust/ca.crt
      PROCESSING_PLATFORM_ENABLED: "true"
      PROCESSING_WORKER_ENABLED: "true"
      LOCAL_DERIVATIVES_ENABLED: "false"
      MESH_DERIVATIVES_ENABLED: "true"
      CLIENT_VIEWER_SHARES_ENABLED: "false"
      VIEWER_REFERENCE_ACCEPTANCE_ENABLED: "false"
      VIEWER_REFERENCE_SOURCE_INTAKE_ENABLED: "false"
      VIEWER_SOURCE_RELEASE_ENABLED: "false"
networks:
  viewer-private:
    name: viewer-staging_viewer-private
    internal: true
    enable_ipv6: false
    ipam:
      config:
        - subnet: 172.30.0.0/16
```

The Processing owner reports that a network-isolated probe of the exact pinned
image found Obj2Tiles available but Entwine absent. Local point-cloud derivative
generation is therefore disabled in this acceptance candidate, with the flag
aligned across API and worker. The Viewer source can discover provider-supplied
EPT output, but an actual staged result must prove that path. LAS/LAZ to EPT
fallback and LiDAR import remain unqualified until an appropriate Entwine
binary and its storage, resource and conversion behavior are separately
provided and tested. Do not treat the disabled flag as completing that scope.

`172.30.0.0/16` is a candidate only: validate all local route tables, Docker
IPAM, host interfaces and current VPN/remote routes before selecting it. The
edge network must retain the guard's exact reviewed address plan. Network
creation must occur before the existing `ExecStartPre` egress guard, with no
Viewer containers running, and only after independently verifying the guard
patch and exact existing network membership.

The old local source is `/home/bkoltz/3d-viewer-staging/storage/data`; it must
remain untouched. Verify redacted Compose output has exactly one `/app/storage/data`
bind per service and points to the new source: Compose merges volume entries by
container target. The new source must be pre-provisioned and guarded; the
`create_host_path: false` setting must not be weakened. A loop filesystem is
only a candidate and is not implied by this bind.
Both services explicitly pin `DATABASE_PATH` to `/app/storage/data/viewer.sqlite`
so an inherited environment file cannot select a different database than the
three filenames inspected by the host verifier.
The prior proposed source under `/home/bkoltz/3d-viewer-staging/storage` does
not satisfy the verifier's root-owned, non-group-writable ancestor requirements.
The `/var/lib` source is an uncreated candidate; validate all ancestors, mount
identity, loop backing file and UID 568 access together before any installation.
On November 10, a read-only check found the candidate path absent and `/var/lib`
on the root ext4 filesystem with approximately 12.16 GB available. This is a
point-in-time observation, not a reservation or a sufficient capacity bound.
The existing in-container guard verifies one non-CIFS database overlay but does
not establish the host source. An independent review of the proposed host guard
found unresolved allocation, loop offset/size/read-only, and nested-mount
checks. Retain the deliberate failing preflight until the corrected verifier and
its pinned identities are independently reviewed and tested.

For the bounded 20-photo test, a simpler alternative under review is a new
task-owned 568:568 mode-0700 database directory directly on the existing root
ext4 filesystem, below root-owned non-writable ancestors. Verify its canonical
path, ownership, exact filesystem and mount identity, absence of nested mounts,
and current headroom before both API and worker starts. The November 10 read-only
observation was root `/dev/mapper/ubuntu--vg-ubuntu--lv` (major:minor `252:0`),
not an identity to trust without a fresh check. Bound input and concurrent work,
measure both local and CIFS space, and stop admission and the worker if a
conservative threshold is breached. Free-space monitoring is not a hard quota or
a guarantee against concurrent writes; proceed only after the owner reviews
credible transient requirements and host activity. No directory has been made.
The Processing owner proposes admitting the single test only at or above 8 GiB
free on root and stopping the worker and new test admission below 7 GiB, with
separate CIFS headroom checks. These are proposed operational thresholds, not a
quota; independently verify them against current workloads and the fixture's
transient requirements. Monitoring must be supervised so its loss stops the
worker, and restart must require fresh space and storage checks. The direct-ext4
directory verifier and monitor candidates are not yet qualified or installed.
The review-only `staging-viewer-candidate/space-monitor.py` checks root and
CIFS byte capacity and local inodes before readiness and each watchdog notification;
the observed CIFS free-inode value is zero and its actual inode capacity is unknown.
the example monitor unit intentionally cannot start. Mock tests do not prove
actual CIFS inode reporting, systemd watchdog behavior, or that the worker stops
when monitoring fails. Obtain independent review and real isolated tests first.
On November 10, two isolated `systemd --user` transient fixtures on `.90`
provided narrower evidence: this chat verified stopping a ready notify monitor
stops its `BindsTo` worker, and the Processing owner reports a missed watchdog
also stopped a bound worker. Both fixtures used task-owned sleep processes, not
the actual monitor, Viewer containers, mounts or system units; no Viewer data
was touched. This chat verified its own transient units were absent afterward.
Another short-lived user service ran the actual monitor with its database path
substituted by the existing `/var/lib` directory, the proposed capacity
thresholds, and real staging root/CIFS observations; it reached systemd READY
and stopped cleanly. The temporary service and file were removed and verified
absent. This did not check the uncreated database path, watchdog expiry in the
actual monitor, the system-level service, or a real Viewer worker/container.
In a separate transient user-service fixture, an injected monitor-check failure
after readiness and a successful cycle caused a bound sleep worker to stop; its
temporary units and Python file were verified absent after cleanup. The first
fixture attempt failed due to test-wrapper variable scope and was cleaned up;
the corrected attempt passed. Neither attempt changed the Viewer service.

## Worker unit shape

The existing API/proxy unit remains responsible for storage and egress guard
application. Its effective `ExecStart` selects only `viewer-api viewer-proxy`.
The named monitor unit does not yet exist. `BindsTo` and `After` are only the
intended dependency shape; the monitor must signal readiness only after a
successful initial measurement, detect its own stalled measurements, and be
tested with systemd so that startup failure, exit, loss and hung monitoring stop
or prevent the worker. `Type=simple` alone would not prove monitor readiness.
Its override must be updated to use the same three files as the worker and a
reviewed DB-source verifier before startup; the current override references only
the first two. Its existing broad `ExecStop` stops the Compose project, so
qualify its interactions with the separate worker and retain the fail-closed
API-stop behavior. The API command currently uses `--force-recreate`; verify
this behavior and rollback image availability before any change.
The observed effective unit runs the existing storage check and then the egress
guard as `ExecStartPre` commands. The later candidate drop-in must append the
DB verifier and a pre-API network-policy verifier after these, before Compose.
The current network verifier requires API/proxy members and therefore cannot
serve that pre-API check without a separately reviewed mode for empty networks.
Compare the actual installed chain rules and jumps with an independently
reviewed expected policy for the pinned network IDs before allowing API start;
never simply trust and pin the live rules. The post-API worker check must verify
the expected API/proxy membership and exact container configuration as well.
Bootstrap also requires explicit root-protected fresh-empty versus
existing-required DB state: a missing database after initialization must fail
closed rather than silently create an empty replacement. The state transition
and recovery after an interrupted first startup remain unqualified.
The example API drop-in uses `Restart=no` for first initialization. After a
successful, checked initialization, replace the fresh-empty preflight with an
existing-required preflight through a reviewed root-owned transition before
restoring normal restart behavior. Do not auto-delete or recreate an incomplete
database after a failed first start; preserve it and inspect the failure.
A separate worker unit would use the *same three Compose files and project*,
and only select the worker. The following is a precise command shape, not an
installable unit: the network verifier path and independently reviewed policy
hash are deliberately unspecified until network IDs and rule semantics exist.

```ini
[Unit]
Description=Viewer staging processing worker (candidate)
Requires=viewer-staging.service viewer-photo-queue-monitor.service docker.service mnt-ViewerStaging.automount
BindsTo=viewer-staging.service viewer-photo-queue-monitor.service mnt-ViewerStaging.mount
PartOf=viewer-staging.service docker.service
After=viewer-staging.service viewer-photo-queue-monitor.service docker.service mnt-ViewerStaging.mount

[Service]
Type=simple
User=bkoltz
WorkingDirectory=/home/bkoltz/3d-viewer-staging
ExecStartPre=+/usr/local/libexec/viewer-staging-storage-check
# REQUIRED, NOT YET SPECIFIED: root-owned verified network-policy check.
# The API unit is Type=simple, so ordering alone does not prove readiness.
ExecStartPre=/usr/bin/timeout 120 /bin/sh -c 'until code=$$(/usr/bin/curl --silent --show-error --max-time 5 --output /dev/null --write-out %%{http_code} --cacert /home/bkoltz/3d-viewer-staging/config/tls.crt --header "Host: viewer-staging.ledgetopdroneservices.com" https://192.168.50.90:8088/api/v1/ready) && [ "$${code}" = 200 ]; do sleep 3; done'
ExecStart=/usr/bin/docker compose -f /home/bkoltz/3d-viewer-staging/compose.yaml -f /home/bkoltz/3d-viewer-staging/compose.viewer-ui-acceptance-20261023.yaml -f /home/bkoltz/3d-viewer-staging/compose.processing-candidate.yaml --profile viewer-processing-held up --no-deps --force-recreate --no-build --pull never --no-color viewer-worker
ExecStop=/usr/bin/docker compose -f /home/bkoltz/3d-viewer-staging/compose.yaml -f /home/bkoltz/3d-viewer-staging/compose.viewer-ui-acceptance-20261023.yaml -f /home/bkoltz/3d-viewer-staging/compose.processing-candidate.yaml --profile viewer-processing-held stop -t 120 viewer-worker
Restart=no
TimeoutStartSec=180
TimeoutStopSec=150
UMask=0077
```

API and worker must use the identical resolved Compose override, immutable
image, local DB mount, staging credential identity, and CA. The real override
must be validated without printing environment secrets. The verifier must
validate the complete reviewed ruleset, bridge identities and membership on
every worker start; a matching chain name or a captured unreviewed baseline is
not sufficient. A read-only check has a time-of-check race, so privileged rule
changes and Docker/network restarts must be fenced or cause the worker to stop.

The worker command deliberately recreates only the selected worker to avoid
reusing stale configuration. Before each start, verify the resolved image,
configuration, mounts and networks against the reviewed candidate, and fail
closed on any mismatch; confirm recreated container identity afterward. A
disposable desktop test of attached Compose commands preserved the same API
container across worker stop and recreate, but cleanup could not be verified
because the shared Docker Desktop daemon became unavailable immediately after
the test. Do not infer staging behavior from that fixture. The old synthetic
Viewer's CA is different from the coordinator CA. Provision the coordinator
CA separately and verify its TLS hostname; do not assume the inherited CA or
credentials are suitable. No values should be printed or copied into evidence.
Place and verify the coordinator CA before starting either Node container:
`NODE_EXTRA_CA_CERTS` is loaded when Node starts. Restart is required after a CA
change. Validate both container mounts and configuration before admission.
Read-only inspection confirms the proposed image digest is present locally on
`.90`. The base Compose file uses an environment file for each service, but the
presence, scope and correctness of coordinator credentials, origin, trust CA,
and source-intake settings have not been established. Do not infer those values
from the image pin or enable a job until the intended protocol and staging-only
identity are verified without exposing credentials.
The Processing owner identified the coordinator's public CA DER SHA-256 as
`a5467195ecf41e6121f435bb29356b63bed52855c29688675c0a5435350c3c05` and
the staging origin as `https://192.168.50.89:18444`. The proposed host CA path
is not provisioned: before use independently verify the public certificate's
fingerprint, validity and IP identity, and root-owned read-only mount in both
services. No CA private key or provider token belongs in these candidate files.
The Processing owner identifies this first isolated milestone as the native
NodeODM-compatible staging provider with ACK v1, not source-intake V2. The
candidate explicitly disables reference acceptance, source-intake V2 and source
release on both services so an inherited environment file cannot enable them.
Before use, configure and test the staging-only provider identity and mount its
verified coordinator CA read-only into both services, with `NODE_EXTRA_CA_CERTS`
set before Node starts. Candidate V2 interoperability remains separate work.

On November 10, read-only inspection showed `/usr/bin/curl` is present and the
current staging certificate's subject alternative name is the IP address
`192.168.50.90`. The readiness command therefore connects to that IP and
supplies the configured Viewer Host header. It has not been run against the
currently stopped service; recheck the certificate, Host policy, timeout and
actual readiness response in the isolated validation before installing a unit.

## Required practical validation before any live use

1. Render and inspect the complete redacted Compose configuration and exact
   effective systemd units; verify no API/worker configuration or mount drift.
2. Prove the actual storage guard accepts the intended mounts and UID 568, and
   retains the CIFS seal and local SQLite/WAL data. Take a consistent database
   backup and preserve the previous image and exact configuration hashes.
   For a separate database, add and test an exact host source, filesystem type,
   mount identity and ownership guard: the existing host guard checks the parent
   path, while the container guard does not verify the host bind source. The
   existing host guard performs a small write/delete probe on staging CIFS; this
   must respect the owner's TrueNAS-operation boundary before any live run.
3. Exercise the exact supervisor split in an isolated systemd-capable fixture:
   API/proxy startup, worker start/stop/restart, API failure, Docker restart,
   storage disappearance, and orphan handling. Stopping the worker must leave
   the same API instance healthy; API or storage loss must stop the worker.
4. Independently review firewall semantics and test positive staging TLS to
   `.89:18444`, denial of other ports and production task IDs, IPv4/IPv6 and
   host ingress/egress boundaries, and behavior after Docker/firewall changes.
5. Establish enforceable limits or a measured safe maximum for local SQLite,
   WAL, Docker metadata, logs and scratch, plus CIFS data headroom and a stop
   condition. Do not assume the host has working filesystem quotas.
6. Confirm all task data and source/archive retention and no automatic cleanup.
   Only then run the authorized small staging acceptance and verify durable
   delivery across the independently supervised worker restart.

Rollback restores the captured unit, guard and Compose files and image. It
leaves the service stopped if the original guarded network/storage state cannot
be restored. It never removes existing networks, databases, volumes, models,
source files or results.
