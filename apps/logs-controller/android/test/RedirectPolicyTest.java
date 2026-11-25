package app.ledgetop.logs;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs on the plain JDK during build.ps1; any failed rule fails the build. Two loopback servers: "checked" answers
 * every request with a redirect to "other". A request opened the app's way (HttpPolicy) carrying both tokens must
 * get the 3xx back, be classed as a redirect, and never reach "other". A control request with the JDK's default
 * redirect-following shows the harness would catch a forward.
 */
public final class RedirectPolicyTest {
    private static int failures = 0;

    private static void check(boolean ok, String what) {
        if (!ok) { failures++; System.err.println("FAIL " + what); }
    }

    public static void main(String[] args) throws Exception {
        InetAddress loopback = InetAddress.getLoopbackAddress();
        AtomicInteger otherHits = new AtomicInteger(), checkedHits = new AtomicInteger();
        HttpServer other = HttpServer.create(new InetSocketAddress(loopback, 0), 0);
        other.createContext("/", exchange -> {
            otherHits.incrementAndGet();
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) { out.write(body); }
        });
        other.start();
        String otherBase = "http://" + loopback.getHostAddress() + ":" + other.getAddress().getPort();
        int[] codes = { 301, 302, 303, 307, 308 };
        AtomicInteger next = new AtomicInteger();
        HttpServer checked = HttpServer.create(new InetSocketAddress(loopback, 0), 0);
        checked.createContext("/", exchange -> {
            checkedHits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().add("Location", otherBase + "/stolen");
            exchange.sendResponseHeaders(codes[Math.floorMod(next.getAndIncrement(), codes.length)], -1);
            exchange.close();
        });
        checked.start();
        String checkedBase = "http://" + loopback.getHostAddress() + ":" + checked.getAddress().getPort();
        try {
            for (String method : new String[] { "GET", "POST", "PUT" }) {
                for (int i = 0; i < codes.length; i++) {
                    HttpURLConnection connection = HttpPolicy.open(new URL(checkedBase + "/api/v1/device/sign-in/abc"), method);
                    connection.setRequestProperty("Authorization", "Bearer device-token");
                    connection.setRequestProperty("X-Poll-Token", "poll-token");
                    if (!method.equals("GET")) {
                        byte[] body = "{\"files\":[]}".getBytes(StandardCharsets.UTF_8);
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(body.length);
                        try (OutputStream out = connection.getOutputStream()) { out.write(body); }
                    }
                    int status = connection.getResponseCode();
                    check(HttpPolicy.isRedirect(status), method + " got the redirect status back (" + status + "), not a followed answer");
                    check(connection.getURL().toString().startsWith(checkedBase), method + " stayed on the checked server");
                    connection.disconnect();
                }
            }
            check(checkedHits.get() == 15, "the checked server saw every request (" + checkedHits.get() + ")");
            check(otherHits.get() == 0, "no request, and so no token, reached the other server (" + otherHits.get() + ")");
            check(!HttpPolicy.isRedirect(200) && !HttpPolicy.isRedirect(401) && !HttpPolicy.isRedirect(299) && !HttpPolicy.isRedirect(400),
                "only 3xx counts as a redirect");

            // Control: the JDK default follows redirects, so the harness does detect a forward.
            HttpURLConnection followed = (HttpURLConnection) new URL(checkedBase + "/control").openConnection();
            followed.setRequestMethod("GET");
            int status = followed.getResponseCode();
            followed.disconnect();
            check(status == 200 && otherHits.get() >= 1, "control: a following client does reach the other server");
        } catch (IOException e) {
            failures++;
            System.err.println("FAIL redirect checks threw " + e);
        } finally {
            checked.stop(0);
            other.stop(0);
        }
        if (failures > 0) { System.err.println(failures + " redirect-policy check(s) failed"); System.exit(1); }
        System.out.println("redirect policy: all checks passed (GET/POST/PUT x 301/302/303/307/308 refused; nothing reached the other server)");
    }

    private RedirectPolicyTest() {}
}
