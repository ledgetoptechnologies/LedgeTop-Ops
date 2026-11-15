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

        if (failures > 0) { System.err.println(failures + " input-policy check(s) failed"); System.exit(1); }
        System.out.println("input policy: all checks passed (" + (synthetic ? "synthetic-only, " + approved.length + " approved" : "real logs") + ")");
    }

    private InputPolicyTest() {}
}
