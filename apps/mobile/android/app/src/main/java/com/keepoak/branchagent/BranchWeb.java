package com.keepoak.branchagent;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import org.json.JSONObject;

/**
 * Opening the owner's Branch inside the app. The page script (www/inject.js) carries no secret in its
 * text and is allowed on the paired address only; so is the message channel it uses to say "take me
 * home" and which theme is showing. Before the window opens, one harmless file is loaded from that
 * address and the key and this phone's own secret are written into that address's session storage,
 * as public/pair.js does after pairing, so the window can send them itself. Any script on the paired
 * address can therefore read both, exactly as in a phone browser.
 */
final class BranchWeb {
    private static JSONObject priming;
    private static String primingAt = "";
    private static Bridge watched;

    private BranchWeb() {}

    /**
     * True when this phone's web view can keep Capacitor's bridge to the app's own page. Without the
     * message-listener feature Capacitor falls back to a bridge every page can call, so the owner's
     * Branch is not opened inside the app at all (it still opens in the browser).
     */
    static boolean safeToOpen() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    /**
     * Points the page script and the message channel at the paired address. Called once, while the
     * window is made and before it shows any page; a new pairing makes the window again.
     */
    static void install(Bridge bridge, JSONObject session) {
        WebView web = bridge.getWebView();
        if (session == null) return;
        Set<String> origin = Collections.singleton(session.optString("origin"));
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, readInject(bridge.getContext()), origin);
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "branchPhone", origin, (view, message, source, main, reply) -> {
                if (main && session.optString("origin").equals(BranchRules.checkOrigin(source.toString()))) handle(bridge, message.getData());
            });
        }
    }

    private static String readInject(Context context) {
        try (InputStream in = context.getAssets().open("public/inject.js")) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return "";
        }
    }

    static void open(Bridge bridge, JSONObject session, String at) {
        priming = session;
        primingAt = at == null ? "" : at;
        watch(bridge);
        bridge.getWebView().loadUrl(session.optString("origin") + "/tokens.css");
    }

    /** Capacitor replaces its listener list after plugins load, so the listener is added on first use. */
    private static void watch(Bridge bridge) {
        if (watched == bridge) return;
        watched = bridge;
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                finishPriming(view);
            }
        });
    }

    private static void finishPriming(WebView view) {
        JSONObject session = priming;
        Uri url = Uri.parse(String.valueOf(view.getUrl()));
        if (session == null || !"/tokens.css".equals(url.getPath()) || !BranchRules.sameOrigin(url.toString(), session.optString("origin"))) return;
        priming = null;
        try {
            JSONObject note = new JSONObject().put("deviceId", session.optString("deviceId")).put("deviceKey", session.optString("deviceKey"))
                .put("at", primingAt).put("home", BranchWords.word(view.getContext(), "phone.home.back", "Back to the phone app"));
            String script = "sessionStorage.setItem('branch-token', " + JSONObject.quote(session.getString("token")) + ");"
                + "sessionStorage.setItem('branch-phone', " + JSONObject.quote(note.toString()) + "); location.replace('/');";
            view.evaluateJavascript(script, null);
        } catch (Exception ignored) {
            // a damaged session simply stays on the phone's own page
        }
    }

    private static void handle(Bridge bridge, String data) {
        try {
            JSONObject message = new JSONObject(data == null ? "{}" : data);
            if ("home".equals(message.optString("type"))) bridge.getWebView().loadUrl(bridge.getAppUrl());
            if ("look".equals(message.optString("type"))) remember(bridge, message.optString("theme", "slate"), message.optString("mode", "dark"));
        } catch (Exception ignored) {
            // an unreadable message is ignored
        }
    }

    /** The window's theme and mode, so the phone's own page and the status bar match it. */
    private static void remember(Bridge bridge, String theme, String mode) {
        BranchWords.state(bridge.getContext()).edit().putString("look-theme", theme).putString("look-mode", mode).apply();
        boolean light = "light".equals(mode);
        WindowCompat.getInsetsController(bridge.getActivity().getWindow(), bridge.getWebView()).setAppearanceLightStatusBars(light);
    }
}
