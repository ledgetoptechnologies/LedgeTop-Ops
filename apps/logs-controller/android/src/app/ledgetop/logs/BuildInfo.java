package app.ledgetop.logs;

/** Build-time constants. The production server is the default; test builds may point elsewhere. */
final class BuildInfo {
    static final String VERSION = "0.3.1";
    static final String DEFAULT_SERVER = "https://logs.ledgetop.app";
    private BuildInfo() {}
}
