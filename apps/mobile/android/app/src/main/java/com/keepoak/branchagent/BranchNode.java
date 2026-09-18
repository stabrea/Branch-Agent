package com.keepoak.branchagent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * mac7/phone-pairing: this phone as one of the owner's devices (src/devices/, docs/configuration.md
 * "Devices"). Everything secret is here and nowhere else:
 *
 *   - the phone's Ed25519 key is made here and sealed with an AES key that never leaves the
 *     **Android Keystore**; only the sealed bytes sit in the app's own private storage, never in
 *     plain preferences. It is never handed to the app's page, never logged and never sent: Branch
 *     is given the public half alone;
 *   - pairing and the wait for the owner's yes happen here, because the app's page may only talk to
 *     itself (its Content-Security-Policy). The address rule is {@link BranchRules#checkOrigin},
 *     the same one the page keeps: https anywhere, plain http only to this network or Tailscale.
 *
 * Android learned Ed25519 in Android 13. On an older phone {@link #canSign()} is false and the card
 * says so plainly rather than making a key of some other kind.
 */
final class BranchNode {
    /** What this phone could do for Branch, before the owner's refusals (apps/mobile/web/phone-node.js). */
    static final List<String> OFFERS = Arrays.asList("camera", "location", "open-url", "speak", "listen", "canvas");
    /** What this phone can promise never to do (apps/mobile/web/rules.js DEVICE_REFUSALS). */
    static final List<String> REFUSALS = Arrays.asList("camera", "screen", "listen", "run");
    private static final String KEY_ALIAS = "branch-node";
    private static final String PREFS = "branch-node";
    private static final String FIELD = "node";
    private final SharedPreferences prefs;

    BranchNode(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Whether this phone's system can make the kind of key Branch asks for. */
    static boolean canSign() {
        try {
            KeyPairGenerator.getInstance("Ed25519");
            return true;
        } catch (Exception missing) {
            return false;
        }
    }

    /** The refusals kept, in a fixed order, with anything unknown dropped. */
    static List<String> keep(List<String> never) {
        List<String> out = new ArrayList<>();
        for (String name : REFUSALS) if (never != null && never.contains(name)) out.add(name);
        return out;
    }

    static List<String> list(JSONArray array) {
        List<String> out = new ArrayList<>();
        for (int at = 0; array != null && at < array.length(); at++) out.add(array.optString(at));
        return out;
    }

    private static SecretKey sealKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    /** Keeps { key (PKCS#8, sealed with the rest), publicKey, hub?, nodeId?, never, pairedAt? }. */
    private void save(JSONObject record) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, sealKey());
        byte[] sealed = cipher.doFinal(record.toString().getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString(FIELD, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
            + Base64.encodeToString(sealed, Base64.NO_WRAP)).apply();
    }

    /** What was kept, or null when nothing is lent or it can no longer be opened. */
    JSONObject load() {
        String packed = prefs.getString(FIELD, null);
        if (packed == null || !packed.contains(".")) return null;
        try {
            String[] parts = packed.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, sealKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception error) {
            return null;
        }
    }

    /** What the page may know. The key itself is never part of this. */
    JSONObject status() {
        JSONObject record = load();
        JSONObject out = new JSONObject();
        try {
            out.put("paired", record != null && record.has("hub") && record.has("nodeId"));
            out.put("origin", record == null ? "" : record.optString("hub", ""));
            out.put("nodeId", record == null ? "" : record.optString("nodeId", ""));
            out.put("pairedAt", record == null ? "" : record.optString("pairedAt", ""));
            out.put("never", new JSONArray(keep(list(record == null ? null : record.optJSONArray("never")))));
            out.put("canSign", canSign());
        } catch (Exception ignored) {
            // A JSONObject of plain strings cannot fail; nothing here is worth losing the answer over.
        }
        return out;
    }

    /** The phone's own refusals. They only take away, so no computer is asked about them. */
    List<String> setNever(List<String> never) throws Exception {
        List<String> kept = keep(never);
        JSONObject record = load();
        if (record == null) record = newKey();
        record.put("never", new JSONArray(kept));
        save(record);
        return kept;
    }

    void forget() {
        prefs.edit().remove(FIELD).apply();
    }

    /** A fresh key for this phone. The private half is sealed straight away and read nowhere else. */
    private JSONObject newKey() throws Exception {
        KeyPair pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        return new JSONObject()
            .put("key", Base64.encodeToString(pair.getPrivate().getEncoded(), Base64.NO_WRAP))
            .put("publicKey", Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP))
            .put("never", new JSONArray());
    }

    private static String sign(JSONObject record, String text) throws Exception {
        PrivateKey key = KeyFactory.getInstance("Ed25519")
            .generatePrivate(new PKCS8EncodedKeySpec(Base64.decode(record.getString("key"), Base64.NO_WRAP)));
        Signature signature = Signature.getInstance("Ed25519");
        signature.initSign(key);
        signature.update(text.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }

    /**
     * Sends the invitation's number and this phone's public key, then asks how it went until the
     * owner answers on the computer. Each ask is signed, which is how Branch knows it is this phone.
     */
    String pair(Context context, String origin, String offer, String code, String name, List<String> never) throws Exception {
        if (!origin.equals(BranchRules.checkOrigin(origin)) || !offer.matches("^[a-f0-9]{32}$") || !code.matches("^[0-9]{6}$"))
            throw new SecurityException("refused");
        JSONObject record = load();
        if (record == null || !record.has("key")) record = newKey();
        List<String> kept = keep(never);
        JSONArray offers = new JSONArray();
        for (String capability : OFFERS) if (!kept.contains(capability)) offers.put(capability);
        JSONObject sent = post(context, origin + "/api/devices/pair", new JSONObject().put("offer", offer).put("code", code)
            .put("name", name).put("platform", "android").put("publicKey", record.getString("publicKey")).put("offers", offers));
        String requestId = sent.optString("requestId", "");
        if (requestId.isEmpty()) throw new IllegalStateException(BranchWords.word(context, "phone.device.failed", "That did not work."));
        JSONObject ask = new JSONObject().put("requestId", requestId).put("signature", sign(record, "branch-node-status-v1\n" + requestId));
        for (int tries = 0; tries < 100; tries++) {
            JSONObject answer = post(context, origin + "/api/devices/pair/status", ask);
            String status = answer.optString("status", "");
            if (status.equals("approved") && !answer.optString("deviceId", "").isEmpty()) {
                record.put("hub", origin).put("nodeId", answer.getString("deviceId")).put("never", new JSONArray(kept))
                    .put("pairedAt", Instant.now().toString());
                save(record);
                return answer.getString("deviceId");
            }
            if (status.equals("refused"))
                throw new IllegalStateException(BranchWords.word(context, "phone.node.refused", "The owner refused this phone."));
            Thread.sleep(3000);
        }
        throw new IllegalStateException(BranchWords.word(context, "phone.node.late", "Nobody answered in time."));
    }

    /** One request to the computer's device door. It carries no key: the number and the signature are the proof. */
    private static JSONObject post(Context context, String address, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = connection.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
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
        Object json = null;
        String text = bytes.toString("UTF-8").trim();
        try { json = text.isEmpty() ? null : new JSONTokener(text).nextValue(); } catch (Exception ignored) { json = null; }
        JSONObject answer = json instanceof JSONObject ? (JSONObject) json : new JSONObject();
        if (status != 200) throw new IllegalStateException(answer.optString("error",
            BranchWords.word(context, "phone.device.failed", "That did not work.")));
        return answer;
    }
}
