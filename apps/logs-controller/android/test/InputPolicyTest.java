package app.ledgetop.logs;

/**
 * Runs on the plain JDK during build.ps1 (before packaging); any failed rule fails the build.
 * Args: <synthetic|real> <comma-separated approved SHA-256 or empty>, matching the generated BuildFlags.
 */
public final class InputPolicyTest {
    private static int failures = 0;

    private static void check(boolean ok, String what) {
        if (!ok) { failures++; System.err.println("FAIL " + what); }
    }

    public static void main(String[] args) {
        boolean synthetic = args.length > 0 && "synthetic".equals(args[0]);
        String[] approved = args.length > 1 && !args[1].isEmpty() ? args[1].split(",") : new String[0];
        check(synthetic == BuildFlags.SYNTHETIC_INPUT_ONLY, "SYNTHETIC_INPUT_ONLY matches the build");
        check(synthetic == InputPolicy.syntheticOnly(), "syntheticOnly() matches the build");
        check(approved.length == BuildFlags.APPROVED_SHA256.length, "approved hash count matches the build");
        check(InputPolicy.SYNTHETIC_FOLDER.equals("synthetic-input"), "synthetic folder name is fixed");

        String unknown = "0000000000000000000000000000000000000000000000000000000000000000";
        if (synthetic) {
            check(approved.length > 0, "a synthetic-input build has at least one approved hash");
            for (String hash : approved) {
                check(InputPolicy.allowed(hash), "approved " + hash + " is allowed");
                check(!InputPolicy.allowed(hash.toUpperCase()), "only the exact lowercase hash is accepted");
                String other = hash.substring(0, 63) + (hash.charAt(63) == '0' ? '1' : '0');
                boolean otherApproved = false;
                for (String h : approved) otherApproved |= h.equals(other);
                if (!otherApproved) check(!InputPolicy.allowed(other), "a hash one character away is refused");
            }
            boolean listsUnknown = false;
            for (String hash : approved) listsUnknown |= hash.equals(unknown);
            if (!listsUnknown) check(!InputPolicy.allowed(unknown), "an unapproved hash is refused");
            check(!InputPolicy.allowed(null), "no hash is refused");
            check(!InputPolicy.allowed(""), "an empty hash is refused");
            check(!InputPolicy.allowed("not-a-hash"), "a malformed hash is refused");
        } else {
            check(approved.length == 0, "a real-logs build bakes in no approved hashes");
            check(InputPolicy.allowed(unknown), "a real-logs build uploads any flight record");
        }

        try { captureChecks(); } catch (Exception e) { failures++; System.err.println("FAIL capture checks threw " + e); }

        if (failures > 0) { System.err.println(failures + " input-policy check(s) failed"); System.exit(1); }
        System.out.println("input policy: all checks passed (" + (synthetic ? "synthetic-only, " + approved.length + " approved" : "real logs") + ")");
    }

    /** Captured bytes are bounded, exact, and immune to later changes of the file they came from. */
    private static void captureChecks() throws java.io.IOException {
        byte[] a = "DJIFlightRecord synthetic A".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        byte[] b = "DJIFlightRecord synthetic B".getBytes(java.nio.charset.StandardCharsets.US_ASCII);   // same size, different bytes
        check(a.length == b.length, "fixtures are the same size");

        byte[] got = InputPolicy.capture(new java.io.ByteArrayInputStream(a), 1024);
        check(got != null && java.util.Arrays.equals(got, a), "capture returns exactly the input bytes");
        check(InputPolicy.capture(new java.io.ByteArrayInputStream(a), a.length) != null, "input exactly at the limit is captured");
        check(InputPolicy.capture(new java.io.ByteArrayInputStream(a), a.length - 1) == null, "input one byte over the limit is refused");
        check(InputPolicy.capture(new java.io.ByteArrayInputStream(new byte[0]), 10).length == 0, "an empty input captures empty");
        check(InputPolicy.SYNTHETIC_MAX_BYTES == 8 * 1024 * 1024 && InputPolicy.SYNTHETIC_MAX_FILES == 16, "capture bounds are fixed");
        // An endless input stops at limit + 1 bytes instead of filling memory.
        java.io.InputStream endless = new java.io.InputStream() { public int read() { return 'x'; }
            public int read(byte[] buf, int off, int len) { java.util.Arrays.fill(buf, off, off + len, (byte) 'x'); return len; } };
        check(InputPolicy.capture(endless, 4096) == null, "an endless input is refused");

        check(InputPolicy.sha256(a).equals(InputPolicy.sha256(a.clone())), "the fingerprint depends only on the bytes");
        check(!InputPolicy.sha256(a).equals(InputPolicy.sha256(b)), "same size, different bytes: different fingerprint");
        check(InputPolicy.sha256(new byte[0]).equals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "SHA-256 matches the standard empty-input vector");

        // Replace the file after capture with different bytes of the same size and the same timestamp: the captured
        // snapshot (what is offered and uploaded) keeps the original bytes and fingerprint.
        java.nio.file.Path file = java.nio.file.Files.createTempFile("DJIFlightRecord_synthetic", ".txt");
        try {
            java.nio.file.Files.write(file, a);
            java.nio.file.attribute.FileTime stamp = java.nio.file.Files.getLastModifiedTime(file);
            byte[] snapshot;
            try (java.io.InputStream in = java.nio.file.Files.newInputStream(file)) { snapshot = InputPolicy.capture(in, 1024); }
            String fingerprint = InputPolicy.sha256(snapshot);
            java.nio.file.Files.write(file, b);
            java.nio.file.Files.setLastModifiedTime(file, stamp);
            check(java.nio.file.Files.size(file) == a.length && java.nio.file.Files.getLastModifiedTime(file).equals(stamp), "replacement keeps size and time");
            check(java.util.Arrays.equals(snapshot, a), "the snapshot keeps the captured bytes after the file changes");
            check(InputPolicy.sha256(snapshot).equals(fingerprint), "the snapshot fingerprint is unchanged after the file changes");
            check(!fingerprint.equals(InputPolicy.sha256(java.nio.file.Files.readAllBytes(file))), "the replaced file has a different fingerprint");
        } finally {
            java.nio.file.Files.deleteIfExists(file);
        }
    }

    private InputPolicyTest() {}
}
