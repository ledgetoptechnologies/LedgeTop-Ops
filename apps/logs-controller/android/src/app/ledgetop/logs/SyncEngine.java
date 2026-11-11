package app.ledgetop.logs;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Finds DJI flight records, asks the server which ones it is missing (by SHA-256, like Dropbox or
 * Google Drive) and uploads only those. Logs never change after a flight, so a file's hash is cached
 * by path, size and modified time. The log folder is only read; nothing is moved or deleted.
 */
final class SyncEngine {
    static final String DEFAULT_SERVER = "http://127.0.0.1:8787";
    /** DJI Pilot 2 (RC Plus, RC Plus 2) keeps logs in shared storage. DJI Fly paths are tried too. */
    static final String[] LOG_FOLDERS = {
        "DJI/com.dji.industry.pilot/FlightRecord",
        "DJI/dji.go.v5/FlightRecord",
        "Android/data/dji.go.v5/files/FlightRecord",
    };
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
    String server() { return prefs.getString("server", DEFAULT_SERVER); }
    String token() { return prefs.getString("token", null); }
    String pilot() { return prefs.getString("pilot", null); }
    boolean signedIn() { return token() != null; }

    void signedIn(String token, String pilot) { prefs.edit().putString("token", token).putString("pilot", pilot).apply(); }
    void signOut() { prefs.edit().remove("token").remove("pilot").putString("status", "Signed out").apply(); }

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

    /** Runs one sync. Only one runs at a time; a second caller waits and then finds nothing to do. */
    void sync() {
        synchronized (LOCK) {
            String token = token();
            if (token == null) return;
            Api api = new Api(server(), token);
            try {
                status("Checking for new flight logs…");
                List<File> logs = findLogs();
                JSONArray files = new JSONArray();
                Map<String, File> byHash = new HashMap<>();
                for (File file : logs) {
                    String hash = hash(file);
                    if (hash == null || byHash.containsKey(hash)) continue;
                    byHash.put(hash, file);
                    files.put(new JSONObject().put("sha256", hash).put("size", file.length()).put("name", file.getName()));
                }
                JSONArray missing = api.post("/api/v1/device/have", new JSONObject().put("files", files)).getJSONArray("missing");
                Set<String> todo = new HashSet<>();
                for (int i = 0; i < missing.length(); i++) todo.add(missing.getString(i));
                int done = 0, failed = 0;
                for (Map.Entry<String, File> entry : byHash.entrySet()) {
                    if (!todo.contains(entry.getKey())) continue;
                    status("Uploading " + (done + failed + 1) + " of " + todo.size() + "…");
                    try { api.putLog(entry.getKey(), entry.getValue()); done++; }
                    catch (IOException e) { failed++; }
                }
                prefs.edit().putLong("lastSync", System.currentTimeMillis()).putInt("logCount", byHash.size())
                    .putInt("failed", failed).putString("status", failed > 0
                        ? failed + (failed == 1 ? " log" : " logs") + " didn’t upload — will retry"
                        : "Up to date").apply();
            } catch (Api.Failure e) {
                if (e.status == 401) signOut();
                status(e.status == 401 ? "Signed out — sign in again" : "Couldn’t reach Ledge Top: " + e.getMessage());
            } catch (IOException e) {
                status("Couldn’t reach Ledge Top — will retry");
            } catch (JSONException e) {
                status("Unexpected answer from Ledge Top — will retry");
            }
        }
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
