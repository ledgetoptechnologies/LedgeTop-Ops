# Viewer browser asset retained for release compatibility

`viewer-gZcdd1xa.js` was reproduced from the prior Viewer frontend and matched
bytes served at the live asset URL when reviewed on 2026-10-29. SHA-256:
`0e2b39ee1c862b2bb732f594026907a277ba98a5f4a146492e7e485b2114f7c3`.
The image build checks this digest and refuses to overwrite a different file at
the same URL. This is a single-asset compatibility measure: the asset references
other chunks and WASM files, which must be independently verified for any
complete old-page compatibility claim. Keep this file until the release owner
has verified the applicable retention interval and subsequent image contents.
