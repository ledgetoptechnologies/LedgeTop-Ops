package app.ledgetop.logs;

/**
 * Runs on the plain JDK during build.ps1 (before packaging); any failed rule fails the build.
 * Args: <allowLoopback true|false> <stagingHost or empty>, matching the generated BuildFlags.
 */
public final class ServerPolicyTest {
    private static int failures = 0;

    private static void expect(boolean expected, String url) {
        boolean actual = BuildInfo.allowedServer(url);
        if (actual != expected) { failures++; System.err.println("FAIL allowedServer(" + url + ") = " + actual + ", expected " + expected); }
    }

    public static void main(String[] args) {
        boolean loopback = args.length > 0 && Boolean.parseBoolean(args[0]);
        String staging = args.length > 1 ? args[1] : "";
        if (loopback != BuildFlags.ALLOW_LOOPBACK) { System.err.println("FAIL flags mismatch"); System.exit(1); }

        expect(true, "https://logs.ledgetop.app");
        expect(true, "https://logs.ledgetop.app/");
        expect(true, "https://LOGS.ledgetop.app");
        // Never: other hosts, look-alikes, other Ledge Top hosts not baked into this build.
        expect(false, "https://evil.example.com");
        expect(false, "https://logs.ledgetop.app.evil.com");
        expect(false, "https://evil-logs.ledgetop.app");
        expect(false, "https://ledgetop.app");
        expect(false, "https://user@logs.ledgetop.app");
        expect(false, "https://logs.ledgetop.app:8443");
        expect(false, "https://logs.ledgetop.app/api");
        expect(false, "https://logs.ledgetop.app?x=1");
        expect(false, "http://logs.ledgetop.app");
        expect(false, "http://evil.example.com:8787");
        expect(false, "file:///sdcard/x");
        expect(false, "");
        expect(false, null);
        expect(false, "not a url");
        // Loopback only in test builds, and only with a port.
        expect(loopback, "http://127.0.0.1:8787");
        expect(loopback, "http://localhost:8787");
        expect(false, "http://127.0.0.1");
        expect(false, "https://127.0.0.1:8787");
        // The staging host only when baked in, exactly.
        if (!staging.isEmpty()) {
            expect(true, "https://" + staging);
            expect(false, "https://" + staging + ":444");
            expect(false, "https://x." + staging);
        }
        expect(false, "https://logs-staging.ledgetop.app".equals("https://" + staging) ? "https://nope.ledgetop.app" : "https://logs-staging.ledgetop.app");

        if (failures > 0) { System.err.println(failures + " server-policy check(s) failed"); System.exit(1); }
        System.out.println("server policy: all checks passed (loopback=" + loopback + ", staging=" + (staging.isEmpty() ? "none" : staging) + ")");
    }

    private ServerPolicyTest() {}
}
