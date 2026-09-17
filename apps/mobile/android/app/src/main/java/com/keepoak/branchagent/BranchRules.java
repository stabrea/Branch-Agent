package com.keepoak.branchagent;

import android.net.Uri;
import java.util.Locale;

/**
 * The phone's address rule, repeated on the native side so no page can talk the app out of it
 * (the same rule as apps/mobile/web/rules.js): https anywhere, plain http only to the owner's own
 * network or Tailscale.
 */
public final class BranchRules {
    private BranchRules() {}

    static boolean isPrivateHost(String hostname) {
        if (hostname == null) return false;
        String host = hostname.toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.isEmpty()) return false;
        if (host.equals("localhost")) return true;
        int[] octets = octets(host);
        if (octets != null) return privateIpv4(octets);
        if (host.contains(":")) return privateIpv6(host);
        for (String suffix : new String[] {".ts.net", ".local", ".home.arpa"}) {
            if (host.endsWith(suffix) && host.length() > suffix.length()) return true;
        }
        return false;
    }

    private static int[] octets(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] out = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("\\d{1,3}")) return null;
            out[i] = Integer.parseInt(parts[i]);
            if (out[i] > 255) return null;
        }
        return out;
    }

    private static boolean privateIpv4(int[] o) {
        return o[0] == 10 || o[0] == 127 || (o[0] == 172 && o[1] >= 16 && o[1] <= 31)
            || (o[0] == 192 && o[1] == 168) || (o[0] == 100 && o[1] >= 64 && o[1] <= 127);
    }

    private static boolean privateIpv6(String host) {
        String bare = host.replace("[", "").replace("]", "");
        return bare.equals("::1") || bare.matches("^f[cd][0-9a-f]{2}:.*");
    }

    /** The origin to keep ("scheme://host[:port]"), or null when the address is refused. */
    static String checkOrigin(String address) {
        if (address == null) return null;
        Uri uri = Uri.parse(address.trim());
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || uri.getUserInfo() != null) return null;
        if (!scheme.equals("https") && !(scheme.equals("http") && isPrivateHost(host))) return null;
        String port = uri.getPort() > 0 ? ":" + uri.getPort() : "";
        String shownHost = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
        return scheme + "://" + shownHost.toLowerCase(Locale.ROOT) + port;
    }

    /** True when `url` is on exactly the paired origin. */
    static boolean sameOrigin(String url, String origin) {
        return origin != null && url != null && origin.equals(checkOrigin(originOf(url)));
    }

    private static String originOf(String url) {
        Uri uri = Uri.parse(url);
        if (uri.getScheme() == null || uri.getHost() == null) return null;
        String port = uri.getPort() > 0 ? ":" + uri.getPort() : "";
        return uri.getScheme() + "://" + uri.getHost() + port;
    }
}
