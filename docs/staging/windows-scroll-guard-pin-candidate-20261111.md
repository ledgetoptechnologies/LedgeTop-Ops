# Activity scroll staging guard pin candidate

Review proposal only; no installer or release is authorized by these pins.

The previously reviewed 0.5.54 reference is commit `8c8267f4ec8d514fc13e4cd70cfb3f8b65adffe0`, application SHA-256 `1312466ab2858c71f9a0d836f2fed492d76ea90e856e9929a88dc652d3154226`, receipt SHA-256 `132a403294e83d1706917b991659b705a4b8975234916ca8809115d93a9ee76d`, and source archive SHA-256 `1f17b2ccfd2635d1b1e343d11bb767b843db17e81d0dd36e92351f3b8dbcb848`.

The compared candidate DLL was locally published from the clean tracked checkout at `203d5258` with staging package settings and version 0.5.54.0; application SHA-256 `905e93a81099d3bfad55dd1ab05ffe7868908b3de8f1a59276a57a752d0e87c8`. It is not an independently attested or archived exact-head build. The source diff changes only ExplorerPreviewWindow and its WPF tests. The preexisting guard refused that DLL; no guard was bypassed.

The same metadata-only comparator referenced by the earlier guard review (source SHA-256 `d226252ff7ae3c94d3e0a36e0afaacae1102ba72d464e35e200f97c92e3319a8`) reported equal resolved operands, references, signatures, locals, headers and exception regions for all seven guarded methods. Its output SHA-256 is `90a25703f1a3d009d834dd1d51f90e40619a75113454404111786dcbe866e795`. The synthetic negative control log SHA-256 is `ba78684ae89ff871118940c2381013d606258ca3474f2a7399fcfc9114d85c2e`. These checks do not prove transitive callee, field initializer, runtime binding, complete signature-array-shape semantics, or build provenance equivalence.

The proposed five IL hash changes leave all existing instruction lengths, staging strings, updater-disabled, startup scope and installer checks intact. Against the compared DLL, the existing scope test and six mutation tests passed; log hashes are `a7b3288d8382e2b4ecacd72a29bf226687fc5e32a72462d347740285fc74dc07` and `5ff852b273da0f8b3defaed7cf8d2bc6cb7bb176b01c024998023bae45aea26d` respectively. They do not execute or qualify the application. An independent review and a fresh exact-head packaged build with the guard rerun are required before considering construction.
