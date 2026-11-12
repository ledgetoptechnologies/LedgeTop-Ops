package app.ledgetop.logs;

import android.content.Context;
import android.net.Uri;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

/**
 * One DJI flight record the app can read: either a plain file in shared storage (DJI Pilot 2 on the RC Plus /
 * RC Plus 2) or a document in a folder the pilot granted once with the system folder picker (DJI Fly keeps its
 * logs in Android/data/dji.go.v5, which Android 11+ only exposes that way). Always read-only.
 */
final class LogFile {
    /** Stable identity for the hash cache: the absolute path, or the document URI. */
    final String key;
    final String name;
    final long size;
    final long lastModified;
    private final File file;
    private final Uri uri;

    private LogFile(String key, String name, long size, long lastModified, File file, Uri uri) {
        this.key = key; this.name = name; this.size = size; this.lastModified = lastModified; this.file = file; this.uri = uri;
    }

    static LogFile of(File file) {
        return new LogFile(file.getAbsolutePath(), file.getName(), file.length(), file.lastModified(), file, null);
    }

    static LogFile of(Uri document, String name, long size, long lastModified) {
        return new LogFile(document.toString(), name, size, lastModified, null, document);
    }

    static boolean isFlightRecord(String name) {
        return name != null && name.endsWith(".txt") && name.contains("FlightRecord");
    }

    InputStream open(Context context) throws IOException {
        if (file != null) return new FileInputStream(file);
        InputStream in = context.getContentResolver().openInputStream(uri);
        if (in == null) throw new FileNotFoundException("flight record unavailable");
        return in;
    }
}
