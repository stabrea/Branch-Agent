package com.keepoak.branchagent;

import java.util.List;

/**
 * The phone's own "never allow" list, applied to the web view itself. Capacitor grants the camera and
 * the microphone to whatever page asks, and the owner's Branch opens in the same web view, so without
 * this a ticked "The camera" or "The microphone" would stop nothing. The phone app's own page (the
 * square-code scanner, "Hold to talk") is the owner's own hand and is not Branch asking, so it keeps
 * both. Plain Java, so tests run it on the computer (src/test/).
 */
final class BranchRefusals {
    static final String VIDEO = "android.webkit.resource.VIDEO_CAPTURE";
    static final String AUDIO = "android.webkit.resource.AUDIO_CAPTURE";

    private BranchRefusals() {}

    /** True when this web page may have every resource it asked for. */
    static boolean mayCapture(List<String> never, String[] resources, boolean ownPage) {
        if (ownPage || resources == null) return true;
        for (String resource : resources) {
            if (VIDEO.equals(resource) && never.contains("camera")) return false;
            if (AUDIO.equals(resource) && never.contains("listen")) return false;
        }
        return true;
    }

    /** "https://localhost" and "https://localhost/" are the same page origin; anything else is not. */
    static boolean sameOrigin(String asking, String appUrl) {
        return trim(asking).equalsIgnoreCase(trim(appUrl));
    }

    private static String trim(String url) {
        String text = url == null ? "" : url;
        int path = text.indexOf('/', text.indexOf("://") + 3);
        return path < 0 ? text : text.substring(0, path);
    }
}
