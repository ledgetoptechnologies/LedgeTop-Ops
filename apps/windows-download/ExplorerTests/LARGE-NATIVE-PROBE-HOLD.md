# Native scale probe: held

The scale entry point and supervisor are deliberately disabled before a root or
process can be created. The environment flag is not a VM identity check.
Do not remove these stops or run this draft until independent review verifies:

- The expected disposable VM and fixed volume by stable machine and volume
  identity, plus sufficient free capacity immediately before creating a fixture.
- The exact complete reviewed build inventory, including the executable and
  every local managed/native dependency, with held identities preventing swaps
  between verification and load. An executable hash alone is insufficient.
- Process creation into an owned kill-on-close job without an uncontained
  launch window, and independent job-zero evidence after normal exit, timeout,
  cancellation, or supervisor failure. No shared process may be terminated.
- A durable pre-registration receipt binding the unique root to volume and
  file identities, native registration context, process identity, and phases.
  A missing or interrupted receipt means registration ownership is uncertain.
- Independent validation of actual native registration and expected placeholder
  counts, and a separately reviewed exact-owner reconciliation procedure. A
  process exit code is not evidence of native cleanup.
- A reviewed policy for retaining test fixtures after failure or interruption;
  do not recursively delete them or unregister an uncertain root.

This fixture would generate 4,996 placeholders and four directories. Only the
five original demo entries have a matching downloadable synthetic source; the
other entries are registration and enumeration fixtures. It would test selected
sample open, Keep, Free and reconnect, not 5,000-file hydration or actual
Explorer shell actions. No network or real account is involved. Interrupted
native creation, restart and recovery need separate explicit acceptance tests.
