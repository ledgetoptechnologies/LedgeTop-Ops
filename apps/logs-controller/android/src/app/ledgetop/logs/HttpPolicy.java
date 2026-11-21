package app.ledgetop.logs;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * How every Ledge Top Logs request is opened. Redirects are never followed: the device token (Authorization) and
 * the sign-in poll token (X-Poll-Token) are only ever sent to the exact server the URL was checked against, never
 * to wherever a 3xx answer points. A 3xx answer is refused like any other failed request (and retried later).
 */
final class HttpPolicy {
    static HttpURLConnection open(URL url, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        return connection;
    }

    static boolean isRedirect(int status) { return status >= 300 && status < 400; }

    private HttpPolicy() {}
}
