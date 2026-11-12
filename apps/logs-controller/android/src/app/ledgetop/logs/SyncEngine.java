package app.ledgetop.logs;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Finds DJI flight records, asks Ledge Top which ones it lacks (by SHA-256) and uploads only those.
 *
 * Sessions: a sign-in is one session (pilot + encrypted device token). Switching pilot retires the current
 * session instead of discarding it: logs written while that pilot was signed in still upload with their
 * session, so the right person gets credit even if the controller was offline. A retired session is signed
 * out on the server once nothing of its is left to send. Logs from before the first sign-in go to whoever
 * signs in first. The log folder is only ever read.
 */
final class SyncEngine {
    /** DJI Pilot 2 (RC Plus, RC Plus 2) keeps logs in shared storage; the DJI Fly paths are tried too. */
    static final String[] LOG_FOLDERS = {
        "DJI/com.dji.industry.pilot/FlightRecord",
        "DJI/dji.go.v5/FlightRecord",
        "Android/data/dji.go.v5/files/FlightRecord",
    };
    /** A log still being written during a flight changes; wait until it has been quiet this long. */
    static final long SETTLE_MS = 2 * 60 * 1000L;
    private static final Object LOCK = new Object();

    private final Context context;
    private final SharedPreferences prefs;
    private final SharedPreferences hashes;

    SyncEngine(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences("logs", Context.MODE_PRIVATE);
        this.hashes = this.context.getSharedPreferences("hashes", Context.MODE_PRIVATE);
    }

    SharedPreferences prefs() { return prefs; }
    String server() { return prefs.getString("server", BuildInfo.DEFAULT_SERVER); }

    // ---- Sessions ---------------------------------------------------------------------------------

    /** The signed-in session: { sealedToken, username, pilotId, signedInAt }, or null. */
    JSONObject current() {
        try { String raw = prefs.getString("session", null); return raw == null ? null : new JSONObject(raw); }
        catch (JSONException e) { return null; }
    }
    boolean signedIn() { return current() != null; }
    String pilot() { JSONObject s = current(); return s == null ? null : s.optString("username", null); }

    void signedIn(String token, String username, String pilotId) throws GeneralSecurityException {
        JSONObject session = new JSONObject();
        try {
            session.put("sealedToken", TokenVault.seal(token)).put("username", username).put("pilotId", pilotId)
                .put("signedInAt", System.currentTimeMillis());
        } catch (JSONException e) { throw new GeneralSecurityException(e); }
        prefs.edit().putString("session", session.toString()).putString("status", "Signed in").remove("reminderAt").remove("revokedAt").remove("signInProblem").apply();
        Notify.clear(context);
    }

    /** Switch pilot: the current session stops taking new logs but keeps sending the ones it owns. */
    void retireCurrent() {
        JSONObject session = current();
        if (session == null) return;
        try {
            session.put("signedOutAt", System.currentTimeMillis());
            JSONArray retired = retired();
            retired.put(session);
            prefs.edit().putString("retired", retired.toString()).remove("session").putString("status", "Signed out").apply();
        } catch (JSONException e) {
            prefs.edit().remove("session").apply();
        }
    }

    /** The server refused the current token (revoked in Ops): forget it. */
    void dropCurrent(String why) {
        prefs.edit().remove("session").putString("status", why).putLong("revokedAt", System.currentTimeMillis())
            .putString("signInProblem", why).apply();
    }

    JSONArray retired() {
        try { return new JSONArray(prefs.getString("retired", "[]")); } catch (JSONException e) { return new JSONArray(); }
    }
    private void saveRetired(JSONArray list) { prefs.edit().putString("retired", list.toString()).apply(); }

    // ---- Logs -------------------------------------------------------------------------------------

    /** Every DJI flight record this app can read, oldest first. */
    List<File> findLogs() {
        File root = Environment.getExternalStorageDirectory();
        List<File> found = new ArrayList<>();
        for (String relative : LOG_FOLDERS) {
            File[] files = new File(root, relative).listFiles();
            if (files == null) continue;
            for (File file : files)
                if (file.isFile() && file.getName().endsWith(".txt") && file.getName().contains("FlightRecord")) found.add(file);
        }
        File[] sorted = found.toArray(new File[0]);
        Arrays.sort(sorted, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        return Arrays.asList(sorted);
    }

    String folderSummary() {
        File root = Environment.getExternalStorageDirectory();
        for (String relative : LOG_FOLDERS) if (new File(root, relative).isDirectory()) return relative;
        return null;
    }

    /** Picks the session a log belongs to: the retired session it was written in, else the current one. */
    private JSONObject ownerOf(File file, JSONObject current, JSONArray retired) {
        long written = file.lastModified();
        for (int i = 0; i < retired.length(); i++) {
            JSONObject s = retired.optJSONObject(i);
            if (s != null && written >= s.optLong("signedInAt") && written < s.optLong("signedOutAt")) return s;
        }
        return current;
    }

    /**
     * Runs one sync. Only one runs at a time. Safe to call from the boot receiver, the job and the screen.
     * Returns true when Ledge Top couldn't be reached (e.g. Wi-Fi still connecting after boot) so the job retries.
     */
    boolean sync() {
        synchronized (LOCK) {
            JSONObject current = current();
            JSONArray retired = retired();
            if (current == null && retired.length() == 0) return false;
            boolean unreachable = false;
            status("Checking for new flight logs…");
            long now = System.currentTimeMillis();
            Map<JSONObject, Map<String, File>> bySession = new LinkedHashMap<>();
            int waiting = 0;
            for (File file : findLogs()) {
                if (now - file.lastModified() < SETTLE_MS) { waiting++; continue; }   // still being written
                JSONObject owner = ownerOf(file, current, retired);
                if (owner == null) continue;                                           // nobody signed in to credit it to
                String hash = hash(file);
                if (hash == null) continue;
                Map<String, File> group = bySession.get(owner);
                if (group == null) { group = new HashMap<>(); bySession.put(owner, group); }
                group.put(hash, file);
            }
            int sent = 0, failed = 0, total = 0;
            String problem = null;
            for (Map.Entry<JSONObject, Map<String, File>> entry : bySession.entrySet()) {
                JSONObject session = entry.getKey();
                boolean isCurrent = session == current;
                String token = TokenVault.open(session.optString("sealedToken", null));
                if (token == null) { if (isCurrent) dropCurrent("Sign in again on this controller"); continue; }
                Api api = new Api(server(), token);
                try {
                    JSONArray files = new JSONArray();
                    for (Map.Entry<String, File> f : entry.getValue().entrySet())
                        files.put(new JSONObject().put("sha256", f.getKey()).put("size", f.getValue().length()).put("name", f.getValue().getName()));
                    JSONArray missing = api.post("/api/v1/device/have", new JSONObject().put("files", files)).getJSONArray("missing");
                    Set<String> todo = new HashSet<>();
                    for (int i = 0; i < missing.length(); i++) todo.add(missing.getString(i));
                    total += todo.size();
                    for (String hash : todo) {
                        status("Uploading " + (sent + failed + 1) + " of " + total + "…");
                        try { api.putLog(hash, entry.getValue().get(hash)); sent++; }
                        catch (Api.Failure e) { if (e.status == 401) throw e; failed++; }
                        catch (IOException e) { failed++; }
                    }
                } catch (Api.Failure e) {
                    if (e.status == 401) {
                        if (isCurrent) { dropCurrent("Signed out from Ledge Top — sign in again"); current = null; }
                        else removeRetired(session);
                    } else { problem = e.getMessage(); failed++; }
                } catch (IOException e) { problem = "Couldn’t reach Ledge Top — will retry"; failed++; unreachable = true; }
                catch (JSONException e) { problem = "Unexpected answer from Ledge Top — will retry"; failed++; }
            }
            finishRetired(bySession, retired);
            prefs.edit().putLong("lastSync", System.currentTimeMillis()).putInt("logCount", findLogs().size()).putInt("failed", failed)
                .putString("status", problem != null ? problem
                    : failed > 0 ? failed + (failed == 1 ? " log" : " logs") + " didn’t upload — will retry"
                    : waiting > 0 ? "Up to date (a flight log is still being written)"
                    : sent > 0 ? "Uploaded " + sent + (sent == 1 ? " log" : " logs") : "Up to date").apply();
            return unreachable;
        }
    }

    /** A retired session with nothing left to send is signed out on the server and forgotten. */
    private void finishRetired(Map<JSONObject, Map<String, File>> bySession, JSONArray retired) {
        JSONArray keep = new JSONArray();
        for (int i = 0; i < retired.length(); i++) {
            JSONObject s = retired.optJSONObject(i);
            if (s == null) continue;
            boolean stillOwns = false;
            Map<String, File> group = bySession.get(s);
            if (group != null && !group.isEmpty()) {
                String token = TokenVault.open(s.optString("sealedToken", null));
                try {
                    JSONArray files = new JSONArray();
                    for (String hash : group.keySet()) files.put(new JSONObject().put("sha256", hash));
                    stillOwns = token != null && new Api(server(), token).post("/api/v1/device/have", new JSONObject().put("files", files)).getJSONArray("missing").length() > 0;
                } catch (Api.Failure e) { stillOwns = e.status != 401 && e.status != 403; }
                catch (IOException | JSONException e) { stillOwns = true; }
            }
            if (stillOwns) { keep.put(s); continue; }
            String token = TokenVault.open(s.optString("sealedToken", null));
            if (token != null) {
                try { new Api(server(), token).post("/api/v1/device/sign-out", new JSONObject()); }
                catch (Api.Failure e) { if (e.status != 401) { keep.put(s); continue; } }
                catch (IOException e) { keep.put(s); continue; }
            }
        }
        saveRetired(keep);
    }

    private void removeRetired(JSONObject session) {
        JSONArray list = retired(), keep = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject s = list.optJSONObject(i);
            if (s != null && s.optLong("signedInAt") != session.optLong("signedInAt")) keep.put(s);
        }
        saveRetired(keep);
    }

    private void status(String text) { prefs.edit().putString("status", text).apply(); }

    /** SHA-256 of the whole file (the same fingerprint OpenDroneLog uses), cached while the file is unchanged. */
    private String hash(File file) {
        String key = file.getAbsolutePath(), stamp = file.length() + ":" + file.lastModified();
        String cached = hashes.getString(key, null);
        if (cached != null && cached.startsWith(stamp + "=")) return cached.substring(stamp.length() + 1);
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) > 0; ) digest.update(buffer, 0, read);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format("%02x", b));
            hashes.edit().putString(key, stamp + "=" + hex).apply();
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException e) {
            return null;
        }
    }
}
