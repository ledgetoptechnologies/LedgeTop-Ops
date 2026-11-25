package app.ledgetop.logs;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * Which flight records this build may ever upload. A normal build reads the DJI apps' log folders. A
 * synthetic-input build (staging device tests) reads nothing but its own test folder, captures each file's bytes
 * once into memory (bounded), fingerprints those exact bytes, and only offers and uploads captured files whose
 * SHA-256 was approved and baked in at build time. The upload sends the same captured bytes, so a file replaced or
 * changed after capture can never be sent under an approved fingerprint. A pilot's real logs are never read.
 */
final class InputPolicy {
    /** The app's own folder (Android/data/app.ledgetop.logs/files/<this>): only adb or the app can write there. */
    static final String SYNTHETIC_FOLDER = "synthetic-input";
    /** A synthetic test file larger than this is not captured at all (fail closed, nothing is offered). */
    static final int SYNTHETIC_MAX_BYTES = 8 * 1024 * 1024;
    /** At most this many synthetic files are captured per scan; any others are ignored. */
    static final int SYNTHETIC_MAX_FILES = 16;

    /** True when this build reads only the synthetic test folder and the approved hashes. */
    static boolean syntheticOnly() { return BuildFlags.SYNTHETIC_INPUT_ONLY; }

    /** Whether a file with this SHA-256 may be offered to the server and uploaded. */
    static boolean allowed(String sha256) {
        if (!syntheticOnly()) return true;
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) return false;
        for (String approved : BuildFlags.APPROVED_SHA256) if (sha256.equals(approved.toLowerCase(Locale.ROOT))) return true;
        return false;
    }

    /**
     * Reads the whole stream into memory, or returns null (nothing captured) when it holds more than maxBytes.
     * Reads at most maxBytes + 1 bytes, so an oversized or endless input never fills memory.
     */
    static byte[] capture(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        for (int read; (read = in.read(buffer, 0, (int) Math.min(buffer.length, (long) maxBytes + 1 - total))) > 0; ) {
            total += read;
            if (total > maxBytes) return null;
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    /** Lowercase hex SHA-256 of exactly these bytes. */
    static String sha256(byte[] bytes) {
        try {
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private InputPolicy() {}
}
