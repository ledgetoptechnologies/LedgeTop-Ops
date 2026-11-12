package app.ledgetop.logs;

/** Build-time constants. The production server is the default; test builds may point elsewhere. */
final class BuildInfo {
    static final String VERSION = "0.3.2";
    static final String DEFAULT_SERVER = "https://logs.ledgetop.app";

    /**
     * The only servers this app will ever talk to: Ledge Top's own HTTPS hosts (production, staging) and,
     * for testing over `adb reverse`, this device's loopback. Anything else (another app sending a server
     * extra, a typo) is refused, so a device token can never be sent to someone else's server.
     */
    static boolean allowedServer(String url) {
        if (url == null) return false;
        try {
            java.net.URI uri = new java.net.URI(url.trim());
            String scheme = uri.getScheme(), host = uri.getHost();
            if (host == null || uri.getUserInfo() != null || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))
                || uri.getQuery() != null || uri.getFragment() != null) return false;
            host = host.toLowerCase(java.util.Locale.ROOT);
            if ("https".equals(scheme)) return uri.getPort() == -1 && (host.equals("ledgetop.app") || host.endsWith(".ledgetop.app"));
            return "http".equals(scheme) && (host.equals("127.0.0.1") || host.equals("localhost")) && uri.getPort() > 0;
        } catch (java.net.URISyntaxException e) {
            return false;
        }
    }
    private BuildInfo() {}
}
