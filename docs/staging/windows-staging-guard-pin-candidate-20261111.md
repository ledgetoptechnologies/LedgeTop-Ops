# Windows staging guard pin candidate, 2026-11-11

Review candidate only. This changes five exact IL hashes, not the checks for
method identity/length, staging strings, disabled updater, production origins,
metadata ambiguity, or payload/installer verification. It does not qualify or
publish any installer.

The prior reviewed reference was source `cd4b230326ab4bade005ff2a19272ccd87f6d0a8`,
version 0.5.52.0, application SHA-256
`3cd1637bbc7cf14e0b83c28982877abe1d91a6ef537c1741ca12dcff7760b8f7`,
receipt SHA-256 `294edb6edde6039b2a5fa2db09913fee829f999680ecf03583b0c76cc47fb5af`,
source archive SHA-256 `e6ffb3d7e832d894748cdb38fd726a3adfbc98fd9fc8e876939711e2ee309a11`.
The candidate payload was built from `ae67881cb7ea480ce4e822217502196c46f6bf82`,
version 0.5.53.0, application SHA-256
`b74e2e90a42d2fadaaef80eb5a0f45feb327b2b85f728ce8ecf8bd9735349a50`,
receipt SHA-256 `fddafceb3db453332da4fecd72609716eeec33a00d3864bc3e82a61804d07bed`,
source archive SHA-256 `e8e328a88064131e2540b5b89f80449ab5fc20f1f8a7eb28af5a0b7f903ecd34`.
These receipts describe unqualified local builds; they are not independent build
provenance attestations.

The App source diff between those commits changes only installer maintenance
and adds the installer version-conflict check; staging qualification, release
profiles and startup source files are unchanged. A local metadata-only comparator
reported equal opcode/operand targets for the seven selected method bodies with
nested type/assembly references, decoded signatures, locals, init-locals,
maxstack and exception regions. Its source SHA-256 is
`d226252ff7ae3c94d3e0a36e0afaacae1102ba72d464e35e200f97c92e3319a8`;
negative controls SHA-256
`12372cdce509769f05ddbe8c6b9369f18bf9eaf8b91c8000d0768624e8d8bc8f`
refused changed opcode, init-locals, stack, locals, exception region, assembly
scope and missing-method fixtures. This comparison does not prove transitive
callee, field initializer, runtime binding, all signature-array-shape semantics,
or build provenance equivalence.

On the candidate DLL, the refreshed existing scope test passed, including
updater-on, changed startup and changed staging-origin negative fixtures; log
SHA-256 `a7b3288d8382e2b4ecacd72a29bf226687fc5e32a72462d347740285fc74dc07`.
The additional six-method byte mutation test passed; log SHA-256
`5ff852b273da0f8b3defaed7cf8d2bc6cb7bb176b01c024998023bae45aea26d`.
A separately compiled staging AppTests assembly passed the synthetic staging
scope check; log SHA-256
`ea47d27ed9356557bd0190bc73493f66397a604df9b607097ddb173fb015f6ce`.
These tests do not execute the candidate app or prove installed or live behavior.
Any subsequent source/build/version change needs a fresh exact build and pin
verification. Independent source/security review and manual-test evidence review
remain required before installer construction.
