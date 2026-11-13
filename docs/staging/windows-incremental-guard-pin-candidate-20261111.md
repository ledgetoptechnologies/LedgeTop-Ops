# Incremental Activity staging guard pin candidate

Review proposal only. No installer or release is authorized.

Compared 0.5.54 local packaged DLLs from tracked checkouts `5338e612` (SHA-256 `1012b726a5bc0d91a37fa7402e2cfd5cc236bc7b0fdede6ed09bab2fea3240ae`) and `2a61e58f` (SHA-256 `80f2b4d27d804bca310c709b9911449451f54b616e0c3bcf6f01aa9fcdd02373`). These direct publishes are not independently archived or provenance-attested. The source diff touches only the Activity window and its tests. The original guard refused the candidate; it was not bypassed.

The previously reviewed metadata comparator (SHA-256 `d226252ff7ae3c94d3e0a36e0afaacae1102ba72d464e35e200f97c92e3319a8`) reported equal resolved operands, references, signatures, locals, headers and exception regions for seven selected guarded methods. The output SHA-256 is `90a25703f1a3d009d834dd1d51f90e40619a75113454404111786dcbe866e795`; its synthetic negative-controls log SHA-256 is `ba78684ae89ff871118940c2381013d606258ca3474f2a7399fcfc9114d85c2e`. This does not establish transitive callee or field initializer equivalence, runtime binding, all signature-array-shape semantics, or reproducible provenance.

This proposal changes four hash literals only; the fifth guarded startup hash is unchanged. Existing method length, origin, updater-disabled, startup, ambiguity and installer checks remain. Against the compared candidate DLL, existing scope and six frozen-method mutation checks pass (log SHA-256 `a7b3288d8382e2b4ecacd72a29bf226687fc5e32a72462d347740285fc74dc07` and `5ff852b273da0f8b3defaed7cf8d2bc6cb7bb176b01c024998023bae45aea26d`). These tests do not execute the application. Independent review and a fresh exact-head archived build with guard checks remain required before installer construction.
