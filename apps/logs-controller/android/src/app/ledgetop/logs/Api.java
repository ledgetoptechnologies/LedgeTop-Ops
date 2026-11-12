package app.ledgetop.logs;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/** Small HTTP client for the Ledge Top Logs device API. Every call runs off the UI thread. */
final class Api {
    static final class Failure extends IOException {
        final int status;
        final String code;
        Failure(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    }

    private final String base;
    private final String token;

    Api(String base, String token) {
        // Defence in depth: never talk to (or send a token to) a server outside the allowed list.
        if (!BuildInfo.allowedServer(base)) throw new IllegalArgumentException("server not allowed");
        this.base = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        this.token = token;
    }

    JSONObject get(String path) throws IOException { return send("GET", path, null, null); }

    /** GET with a header-only secret (the sign-in poll token), so it never appears in a URL. */
    JSONObject getWithHeader(String path, String header, String value) throws IOException { return send("GET", path, null, new String[] { header, value }); }

    JSONObject post(String path, JSONObject body) throws IOException { return send("POST", path, body, null); }

    /** Streams one raw log; the server checks it against the SHA-256 in the path before keeping it. */
    JSONObject putLog(String sha256, File file) throws IOException {
        String path = "/api/v1/device/logs/" + sha256 + "?name=" + URLEncoder.encode(file.getName(), "UTF-8");
        HttpURLConnection connection = open("PUT", path);
        connection.setRequestProperty("Content-Type", "application/octet-stream");
        connection.setFixedLengthStreamingMode(file.length());
        connection.setDoOutput(true);
        try (InputStream in = new FileInputStream(file); OutputStream out = connection.getOutputStream()) {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
        }
        return read(connection);
    }

    private JSONObject send(String method, String path, JSONObject body, String[] header) throws IOException {
        HttpURLConnection connection = open(method, path);
        if (header != null) connection.setRequestProperty(header[0], header[1]);
        if (body != null) {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
        }
        return read(connection);
    }

    private HttpURLConnection open(String method, String path) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(120_000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "LedgeTopLogs-Android/" + BuildInfo.VERSION);
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        return connection;
    }

    private static JSONObject read(HttpURLConnection connection) throws IOException {
        try {
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = "";
            if (stream != null) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int read; (read = stream.read(buffer)) > 0; ) out.write(buffer, 0, read);
                text = out.toString("UTF-8");
            }
            JSONObject json;
            try { json = text.isEmpty() ? new JSONObject() : new JSONObject(text); }
            catch (JSONException e) { json = new JSONObject(); }
            if (status >= 400) throw new Failure(status, json.optString("code", ""), json.optString("error", "Request failed (" + status + ")"));
            return json;
        } finally {
            connection.disconnect();
        }
    }
}
