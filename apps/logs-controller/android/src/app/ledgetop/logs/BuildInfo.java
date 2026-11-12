package app.ledgetop.logs;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** Build-time constants. The production server is the default and, in a production build, the only one. */
final class BuildInfo {
    static final String VERSION = "0.3.4";
    static final String PRODUCTION_HOST = "logs.ledgetop.app";
    static final String DEFAULT_SERVER = "https://" + PRODUCTION_HOST;

    /**
     * The only servers this build will ever talk to:
     * - https://logs.ledgetop.app;
     * - the exact staging host baked into a staging build (BuildFlags.EXTRA_HOSTS);
     * - http loopback with a port (adb reverse), in test builds only (BuildFlags.ALLOW_LOOPBACK).
     * Anything else is refused, so a device token can never be sent to another server.
     */
    static boolean allowedServer(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url.trim());
            String scheme = uri.getScheme(), host = uri.getHost(), path = uri.getRawPath();
            if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) return false;
            if (path != null && !path.isEmpty() && !path.equals("/")) return false;
            host = host.toLowerCase(Locale.ROOT);
            if ("https".equals(scheme)) {
                if (uri.getPort() != -1) return false;
                if (host.equals(PRODUCTION_HOST)) return true;
                for (String extra : BuildFlags.EXTRA_HOSTS) if (host.equals(extra)) return true;
                return false;
            }
            return BuildFlags.ALLOW_LOOPBACK && "http".equals(scheme) && (host.equals("127.0.0.1") || host.equals("localhost")) && uri.getPort() > 0;
        } catch (URISyntaxException e) {
            return false;
        }
    }

    private BuildInfo() {}
}
