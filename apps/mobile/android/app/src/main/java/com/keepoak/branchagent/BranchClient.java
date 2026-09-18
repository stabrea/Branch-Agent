package com.keepoak.branchagent;

import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.json.JSONTokener;

/** The one way the phone talks to the paired Branch: the key goes in the headers, never in a page. */
final class BranchClient {
    static final class Answer {
        final int status;
        final Object json;

        Answer(int status, Object json) {
            this.status = status;
            this.json = json;
        }
    }

    private BranchClient() {}

    /** A request to the paired Branch. `raw` (base64) is sent as-is with `contentType`; otherwise `json`. */
    static Answer send(JSONObject session, String method, String path, Object json, String raw, String contentType, String query)
        throws Exception {
        String origin = session.getString("origin");
        if (!origin.equals(BranchRules.checkOrigin(origin)) || !path.matches("^/api/[A-Za-z0-9/_-]+$")) throw new SecurityException("refused");
        String address = origin + path + (query != null && query.matches("^[A-Za-z0-9=&._-]*$") && !query.isEmpty() ? "?" + query : "");
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(120000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Authorization", "Bearer " + session.getString("token"));
        if (session.has("deviceId") && session.has("deviceKey")) {
            connection.setRequestProperty("x-branch-device", session.getString("deviceId"));
            connection.setRequestProperty("x-branch-device-key", session.getString("deviceKey"));
        }
        byte[] body = raw != null ? Base64.decode(raw, Base64.DEFAULT) : json != null ? json.toString().getBytes(StandardCharsets.UTF_8) : null;
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", raw != null ? (contentType == null ? "application/octet-stream" : contentType) : "application/json");
            try (OutputStream out = connection.getOutputStream()) { out.write(body); }
        }
        return read(connection);
    }

    /** The pairing request (src/server.ts pairingRequest); it needs no key yet. */
    static Answer pair(String origin, JSONObject body) throws Exception {
        if (!origin.equals(BranchRules.checkOrigin(origin))) throw new SecurityException("refused");
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + "/api/pair").openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = connection.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        return read(connection);
    }

    private static Answer read(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        if (stream != null) {
            try (InputStream in = stream) {
                byte[] buffer = new byte[8192];
                for (int n; (n = in.read(buffer)) > 0; ) bytes.write(buffer, 0, n);
            }
        }
        connection.disconnect();
        String text = bytes.toString("UTF-8").trim();
        Object json = null;
        try { json = text.isEmpty() ? null : new JSONTokener(text).nextValue(); } catch (Exception ignored) { json = null; }
        return new Answer(status, json);
    }
}
