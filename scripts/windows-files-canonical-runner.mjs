// Miniflare's synchronous proxy launches an eval Worker containing CommonJS
// require(). Inherited --input-type=module makes that Worker fail while its
// caller can remain in Atomics.wait(). Do not strip flags or alter the runtime.
export function assertCanonicalFileRunner(execArgv = process.execArgv) {
  if (execArgv.some(argument => argument === '--input-type' || argument.startsWith('--input-type=')))
    throw Error('canonical_replay_use_file_runner');
}
