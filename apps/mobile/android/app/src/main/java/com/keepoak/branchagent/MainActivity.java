package com.keepoak.branchagent;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BranchPhonePlugin.class);
        super.onCreate(savedInstanceState);
        takeShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        takeShare(intent);
    }

    /** Something was shared in: show the phone app's own page, which offers to send it. */
    private void takeShare(Intent intent) {
        if (!BranchShareInbox.accept(this, intent) || bridge == null) return;
        String here = String.valueOf(bridge.getWebView().getUrl());
        if (here.startsWith(bridge.getAppUrl())) bridge.triggerDocumentJSEvent("branch-shared");
        else bridge.getWebView().loadUrl(bridge.getAppUrl());
    }

    /** When the app was last on screen, for the "lock when needed" switch. */
    @Override
    public void onPause() {
        super.onPause();
        BranchWords.state(this).edit().putLong("last-seen", System.currentTimeMillis()).apply();
    }
}
