package com.keepoak.branchagent;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.time.Instant;
import org.json.JSONObject;

/**
 * The phone app's page talks to the phone through this plugin only (apps/mobile/web/vault.js). The
 * key a Branch hands over stays here and in the Keystore-sealed vault; the page never receives it.
 */
@CapacitorPlugin(name = "BranchPhone", permissions = { @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }) })
public class BranchPhonePlugin extends Plugin {
    private BranchVault vault;

    @Override
    public void load() {
        vault = new BranchVault(getContext());
        BranchWeb.install(getBridge(), vault.load());
        BranchShareInbox.applySwitch(getContext());
    }

    @PluginMethod
    public void pair(PluginCall call) {
        String origin = BranchRules.checkOrigin(call.getString("origin", ""));
        if (origin == null) {
            call.resolve(result("paired", false).put("error", BranchWords.word(getContext(), "phone.error.plainHttp", "That address is refused.")));
            return;
        }
        getBridge().execute(() -> {
            try {
                JSONObject body = new JSONObject().put("id", call.getString("id", "")).put("code", call.getString("code", ""))
                    .put("name", call.getString("name", Build.MODEL));
                BranchClient.Answer answer = BranchClient.pair(origin, body);
                JSONObject json = answer.json instanceof JSONObject ? (JSONObject) answer.json : new JSONObject();
                if (answer.status != 200 || !json.has("token")) {
                    call.resolve(result("paired", false).put("error", json.optString("error",
                        BranchWords.word(getContext(), "phone.error.pairFailed", "That did not work."))));
                    return;
                }
                JSONObject session = new JSONObject().put("origin", origin).put("token", json.getString("token"))
                    .put("pairedAt", Instant.now().toString());
                if (json.has("deviceId")) session.put("deviceId", json.getString("deviceId")).put("deviceKey", json.getString("deviceKey"));
                vault.save(session);
                call.resolve(result("paired", true));
                restartWindow();
            } catch (Exception error) {
                call.resolve(result("paired", false).put("error", String.valueOf(error.getMessage())));
            }
        });
    }

    /**
     * The page script and its message channel are set up only while the window is being made
     * (load()): adding them to a web view that has already shown a page crashed the system web view
     * on the test emulator. So a change of pairing makes the window again.
     */
    private void restartWindow() {
        getActivity().runOnUiThread(() -> getActivity().recreate());
    }

    private static JSObject result(String key, boolean value) {
        JSObject out = new JSObject();
        out.put(key, value);
        return out;
    }

    @PluginMethod
    public void session(PluginCall call) {
        JSONObject session = vault.load();
        if (session == null) {
            call.resolve(result("paired", false));
            return;
        }
        call.resolve(result("paired", true).put("origin", session.optString("origin")).put("pairedAt", session.optString("pairedAt"))
            .put("deviceId", session.optString("deviceId")));
    }

    @PluginMethod
    public void forget(PluginCall call) {
        vault.forget();
        call.resolve();
        restartWindow();
    }

    @PluginMethod
    public void request(PluginCall call) {
        JSONObject session = vault.load();
        if (session == null) {
            call.reject("Not paired");
            return;
        }
        getBridge().execute(() -> {
            try {
                BranchClient.Answer answer = BranchClient.send(session, call.getString("method", "GET"), call.getString("path", ""),
                    call.getData().opt("body") == JSONObject.NULL ? null : call.getData().opt("body"),
                    call.getString("base64"), call.getString("contentType"), call.getString("query"));
                JSObject out = new JSObject();
                out.put("status", answer.status);
                out.put("data", answer.json == null ? JSONObject.NULL : answer.json);
                call.resolve(out);
            } catch (Exception error) {
                call.reject(String.valueOf(error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void getSwitches(PluginCall call) {
        JSObject out = new JSObject();
        out.put("switches", BranchWords.switches(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void setSwitches(PluginCall call) {
        JSObject next = call.getObject("switches", new JSObject());
        BranchWords.saveSwitches(getContext(), next == null ? new JSONObject() : next);
        call.resolve();
    }

    /** Asks for what a switch now needs: permission to notify, the background job, the share target. */
    @PluginMethod
    public void switchesChanged(PluginCall call) {
        BranchShareInbox.applySwitch(getContext());
        BranchNotify.schedule(getContext());
        boolean wantsAlerts = !BranchWords.position(getContext(), "notifications").equals("off");
        if (wantsAlerts && Build.VERSION.SDK_INT >= 33 && getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        call.resolve();
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void afterPermission(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getActivity().runOnUiThread(() -> promptBiometric(call));
            return;
        }
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        Intent confirm = keyguard == null ? null : keyguard.createConfirmDeviceCredentialIntent(call.getString("reason", "Branch"), null);
        if (confirm == null) {
            call.resolve(result("unlocked", false).put("reason", "unavailable"));
            return;
        }
        startActivityForResult(call, confirm, "afterConfirm");
    }

    @ActivityCallback
    private void afterConfirm(PluginCall call, ActivityResult result) {
        call.resolve(result("unlocked", result.getResultCode() == android.app.Activity.RESULT_OK));
    }

    private void promptBiometric(PluginCall call) {
        BiometricPrompt.Builder builder = new BiometricPrompt.Builder(getContext()).setTitle(call.getString("reason", "Branch"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
                | android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        } else {
            builder.setDeviceCredentialAllowed(true);
        }
        builder.build().authenticate(new CancellationSignal(), getContext().getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                call.resolve(result("unlocked", true));
            }

            @Override
            public void onAuthenticationError(int code, CharSequence message) {
                call.resolve(result("unlocked", false).put("reason", String.valueOf(message)));
            }
        });
    }

    @PluginMethod
    public void openBranch(PluginCall call) {
        JSONObject session = vault.load();
        if (session == null) {
            call.reject("Not paired");
            return;
        }
        getActivity().runOnUiThread(() -> {
            BranchWeb.open(getBridge(), session, call.getString("at", ""));
            call.resolve();
        });
    }

    @PluginMethod
    public void look(PluginCall call) {
        JSObject out = new JSObject();
        out.put("theme", BranchWords.state(getContext()).getString("look-theme", "forest"));
        out.put("mode", BranchWords.state(getContext()).getString("look-mode", "dark"));
        call.resolve(out);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        BranchNotify.show(getContext(), call.getString("id", "branch"), call.getString("title", "Branch"), call.getString("body", ""));
        call.resolve();
    }

    @PluginMethod
    public void lastSeen(PluginCall call) {
        JSObject out = new JSObject();
        out.put("at", BranchWords.state(getContext()).getLong("last-seen", 0L));
        call.resolve(out);
    }

    @PluginMethod
    public void takeShared(PluginCall call) {
        JSObject out = new JSObject();
        out.put("items", BranchShareInbox.take());
        call.resolve(out);
    }

    @PluginMethod
    public void clearShared(PluginCall call) {
        BranchShareInbox.take();
        call.resolve();
    }

    /** Only the paired Branch opens inside the app; every other address goes to the browser as before. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        JSONObject session = vault == null ? null : vault.load();
        if (session != null && BranchRules.sameOrigin(url.toString(), session.optString("origin"))) return false;
        return null;
    }

    static ComponentName component(Context context, String name) {
        return new ComponentName(context, context.getPackageName() + name);
    }
}
