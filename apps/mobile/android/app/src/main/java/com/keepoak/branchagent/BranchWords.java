package com.keepoak.branchagent;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** Words (from public/locales, through the generated branch_strings.xml files) and the phone's switches. */
final class BranchWords {
    static final String[] SWITCHES = {"lock", "notifications", "push", "share", "voice"};

    private BranchWords() {}

    static String word(Context context, String key, String english) {
        int id = context.getResources().getIdentifier(key.replace('.', '_'), "string", context.getPackageName());
        return id == 0 ? english : context.getString(id);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("branch-phone", Context.MODE_PRIVATE);
    }

    /** Every switch starts off; an unknown position reads as off. */
    static JSONObject switches(Context context) {
        JSONObject out = new JSONObject();
        SharedPreferences prefs = prefs(context);
        for (String name : SWITCHES) {
            String value = prefs.getString("switch-" + name, "off");
            try {
                out.put(name, value.equals("on") || value.equals("when-needed") ? value : "off");
            } catch (Exception ignored) {
                // a fixed key never fails
            }
        }
        return out;
    }

    static String position(Context context, String name) {
        return switches(context).optString(name, "off");
    }

    static void saveSwitches(Context context, JSONObject next) {
        SharedPreferences.Editor editor = prefs(context).edit();
        for (String name : SWITCHES) {
            String value = next.optString(name, "off");
            editor.putString("switch-" + name, value.equals("on") || value.equals("when-needed") ? value : "off");
        }
        editor.apply();
    }

    static SharedPreferences state(Context context) {
        return prefs(context);
    }
}
