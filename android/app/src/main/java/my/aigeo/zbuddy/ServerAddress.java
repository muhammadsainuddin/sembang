package my.aigeo.zbuddy;

import java.net.URI;
import java.util.Locale;

/** A server is a single trusted origin, never an arbitrary document or credential-bearing URL. */
final class ServerAddress {
    final String origin;
    private ServerAddress(String value) { origin = value; }
    static ServerAddress parse(String input) throws IllegalArgumentException {
        try {
            URI uri = new URI(input.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            int port = uri.getPort();
            if (host.isEmpty() || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || port == 0 || port > 65535 || port < -1) throw new Exception();
            if (uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/")) throw new Exception();
            boolean local = host.equals("localhost") || host.equals("127.0.0.1");
            if (!scheme.equals("https") && !(scheme.equals("http") && local)) throw new Exception();
            boolean standard = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
            return new ServerAddress(scheme + "://" + host + (standard ? "" : ":" + port));
        } catch (Exception e) { throw new IllegalArgumentException("Enter a full HTTPS address, for example https://chat.example.com. HTTP is allowed only for localhost during USB testing."); }
    }
    boolean matches(String input) {
        try {
            URI uri = new URI(input);
            int port = uri.getPort();
            String scheme = uri.getScheme(), host = uri.getHost();
            if (scheme == null || host == null || uri.getRawUserInfo() != null) return false;
            String address = scheme.toLowerCase(Locale.ROOT) + "://" + host.toLowerCase(Locale.ROOT);
            if (port != -1 && !(scheme.equalsIgnoreCase("https") && port == 443) && !(scheme.equalsIgnoreCase("http") && port == 80)) address += ":" + port;
            return origin.equals(address);
        } catch (Exception e) { return false; }
    }
}
