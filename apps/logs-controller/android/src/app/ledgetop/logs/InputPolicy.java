package app.ledgetop.logs;

import java.util.Locale;

/**
 * Which flight records this build may ever upload. A normal build reads the DJI apps' log folders. A
 * synthetic-input build (staging device tests) reads nothing but its own test folder, and only uploads files
 * whose SHA-256 was approved and baked in at build time. Anything else, including a pilot's real logs that end
 * up in the test folder, is never hashed into a request, offered to the server or uploaded.
 */
final class InputPolicy {
    /** The app's own folder (Android/data/app.ledgetop.logs/files/<this>): only adb or the app can write there. */
    static final String SYNTHETIC_FOLDER = "synthetic-input";

    /** True when this build reads only the synthetic test folder and the approved hashes. */
    static boolean syntheticOnly() { return BuildFlags.SYNTHETIC_INPUT_ONLY; }

    /** Whether a file with this SHA-256 may be offered to the server and uploaded. */
    static boolean allowed(String sha256) {
        if (!syntheticOnly()) return true;
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) return false;
        for (String approved : BuildFlags.APPROVED_SHA256) if (sha256.equals(approved.toLowerCase(Locale.ROOT))) return true;
        return false;
    }

    private InputPolicy() {}
}
