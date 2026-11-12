package app.ledgetop.logs;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;

import java.io.File;
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
    String server() {
        String value = prefs.getString("server", BuildInfo.DEFAULT_SERVER);
        return BuildInfo.allowedServer(value) ? value : BuildInfo.DEFAULT_SERVER;
    }

    /**
     * The server that issued this session's token: the only place that token is ever sent. Null when the
     * session has no valid recorded issuer; such a session is never used (it is never inferred from the
     * current setting, which another app could have changed).
     */
    static String serverOf(JSONObject session) {
        String bound = session == null ? null : session.optString("server", null);
        return BuildInfo.allowedServer(bound) ? bound : null;
    }

    // ---- Sessions ---------------------------------------------------------------------------------

    /** The signed-in session: { sealedToken, username, pilotId, signedInAt }, or null. */
    JSONObject current() {
        try {
            String raw = prefs.getString("session", null);
            if (raw == null) return null;
            JSONObject session = new JSONObject(raw);
            // No valid recorded issuer (sessions from before 0.3.2, or tampered): fail closed. The pilot signs in
            // again; the old device can be signed out from Ops. Its token is never sent anywhere.
            if (serverOf(session) == null) { dropCurrent("Sign in again on this controller"); return null; }
            return session;
        } catch (JSONException e) { prefs.edit().remove("session").apply(); return null; }
    }
    boolean signedIn() { return current() != null; }
    String pilot() { JSONObject s = current(); return s == null ? null : s.optString("username", null); }

    void signedIn(String token, String username, String pilotId, String issuedBy) throws GeneralSecurityException {
        if (!BuildInfo.allowedServer(issuedBy)) throw new GeneralSecurityException("server not allowed");
        JSONObject session = new JSONObject();
        try {
            session.put("sealedToken", TokenVault.seal(token)).put("server", issuedBy).put("username", username).put("pilotId", pilotId)
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

    /** Previous pilots' sessions still sending their logs. Any without a valid recorded issuer are dropped. */
    JSONArray retired() {
        JSONArray all;
        try { all = new JSONArray(prefs.getString("retired", "[]")); } catch (JSONException e) { all = new JSONArray(); }
        JSONArray usable = new JSONArray();
        for (int i = 0; i < all.length(); i++) { JSONObject s = all.optJSONObject(i); if (serverOf(s) != null) usable.put(s); }
        if (usable.length() != all.length()) saveRetired(usable);
        return usable;
    }
    private void saveRetired(JSONArray list) { prefs.edit().putString("retired", list.toString()).apply(); }

    // ---- Logs -------------------------------------------------------------------------------------

    /** Every DJI flight record this app can read, oldest first: shared-storage folders plus the granted folder. */
    List<LogFile> findLogs() {
        File root = Environment.getExternalStorageDirectory();
        List<LogFile> found = new ArrayList<>();
        for (String relative : LOG_FOLDERS) {
            File[] files = new File(root, relative).listFiles();
            if (files == null) continue;
            for (File file : files) if (file.isFile() && LogFile.isFlightRecord(file.getName())) found.add(LogFile.of(file));
        }
        found.addAll(treeLogs());
        LogFile[] sorted = found.toArray(new LogFile[0]);
        Arrays.sort(sorted, (a, b) -> Long.compare(a.lastModified, b.lastModified));
        return Arrays.asList(sorted);
    }

    /**
     * The folder the pilot granted with the system folder picker, if that read grant is still held. DJI Fly keeps
     * its flight records in Android/data/dji.go.v5, which Android 11+ only exposes to other apps this way.
     */
    Uri logTree() {
        String saved = prefs.getString("logTreeUri", null);
        if (saved == null) return null;
        Uri tree = Uri.parse(saved);
        for (UriPermission grant : context.getContentResolver().getPersistedUriPermissions())
            if (grant.getUri().equals(tree) && grant.isReadPermission()) return tree;
        return null;
    }

    /** Keeps a folder the pilot picked: read-only, and it survives reboots. */
    void rememberLogTree(Uri tree) {
        context.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        prefs.edit().putString("logTreeUri", tree.toString()).apply();
    }

    private List<LogFile> treeLogs() {
        List<LogFile> found = new ArrayList<>();
        Uri tree = logTree();
        if (tree == null) return found;
        try {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            String[] columns = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_MIME_TYPE };
            try (Cursor cursor = context.getContentResolver().query(children, columns, null, null, null)) {
                while (cursor != null && cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(4)) || !LogFile.isFlightRecord(name)) continue;
                    found.add(LogFile.of(DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0)), name, cursor.getLong(2), cursor.getLong(3)));
                }
            }
        } catch (RuntimeException e) {
            // The grant was revoked or the folder is gone: read nothing from it (the screen offers to choose again).
        }
        return found;
    }

    /** Android 11+, no folder granted yet: DJI Fly's logs need the one-time folder picker. */
    boolean canChooseLogFolder() { return Build.VERSION.SDK_INT >= 30 && logTree() == null; }

    String folderSummary() {
        if (logTree() != null) return "the DJI Fly folder you chose";
        File root = Environment.getExternalStorageDirectory();
        for (String relative : LOG_FOLDERS) if (new File(root, relative).isDirectory()) return relative;
        return null;
    }

    /** Picks the session a log belongs to: the retired session it was written in, else the current one. */
    private JSONObject ownerOf(LogFile file, JSONObject current, JSONArray retired) {
        long written = file.lastModified;
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
            Map<JSONObject, Map<String, LogFile>> bySession = new LinkedHashMap<>();
            int waiting = 0;
            for (LogFile file : findLogs()) {
                if (now - file.lastModified < SETTLE_MS) { waiting++; continue; }   // still being written
                JSONObject owner = ownerOf(file, current, retired);
                if (owner == null) continue;                                           // nobody signed in to credit it to
                String hash = hash(file);
                if (hash == null) continue;
                Map<String, LogFile> group = bySession.get(owner);
                if (group == null) { group = new HashMap<>(); bySession.put(owner, group); }
                group.put(hash, file);
            }
            int sent = 0, failed = 0, total = 0;
            String problem = null;
            for (Map.Entry<JSONObject, Map<String, LogFile>> entry : bySession.entrySet()) {
                JSONObject session = entry.getKey();
                boolean isCurrent = session == current;
                String token = TokenVault.open(session.optString("sealedToken", null));
                if (token == null) { if (isCurrent) dropCurrent("Sign in again on this controller"); continue; }
                Api api = new Api(serverOf(session), token);
                try {
                    JSONArray files = new JSONArray();
                    for (Map.Entry<String, LogFile> f : entry.getValue().entrySet())
                        files.put(new JSONObject().put("sha256", f.getKey()).put("size", f.getValue().size).put("name", f.getValue().name));
                    JSONArray missing = api.post("/api/v1/device/have", new JSONObject().put("files", files)).getJSONArray("missing");
                    Set<String> todo = new HashSet<>();
                    for (int i = 0; i < missing.length(); i++) todo.add(missing.getString(i));
                    total += todo.size();
                    for (String hash : todo) {
                        status("Uploading " + (sent + failed + 1) + " of " + total + "…");
                        try { api.putLog(hash, entry.getValue().get(hash), context); sent++; }
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
    private void finishRetired(Map<JSONObject, Map<String, LogFile>> bySession, JSONArray retired) {
        JSONArray keep = new JSONArray();
        for (int i = 0; i < retired.length(); i++) {
            JSONObject s = retired.optJSONObject(i);
            if (s == null) continue;
            boolean stillOwns = false;
            Map<String, LogFile> group = bySession.get(s);
            if (group != null && !group.isEmpty()) {
                String token = TokenVault.open(s.optString("sealedToken", null));
                try {
                    JSONArray files = new JSONArray();
                    for (String hash : group.keySet()) files.put(new JSONObject().put("sha256", hash));
                    stillOwns = token != null && new Api(serverOf(s), token).post("/api/v1/device/have", new JSONObject().put("files", files)).getJSONArray("missing").length() > 0;
                } catch (Api.Failure e) { stillOwns = e.status != 401 && e.status != 403; }
                catch (IOException | JSONException e) { stillOwns = true; }
            }
            if (stillOwns) { keep.put(s); continue; }
            String token = TokenVault.open(s.optString("sealedToken", null));
            if (token != null) {
                try { new Api(serverOf(s), token).post("/api/v1/device/sign-out", new JSONObject()); }
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
    private String hash(LogFile file) {
        String key = file.key, stamp = file.size + ":" + file.lastModified;
        String cached = hashes.getString(key, null);
        if (cached != null && cached.startsWith(stamp + "=")) return cached.substring(stamp.length() + 1);
        try (InputStream in = file.open(context)) {
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
