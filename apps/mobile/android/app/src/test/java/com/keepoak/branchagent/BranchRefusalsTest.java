package com.keepoak.branchagent;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class BranchRefusalsTest {
    private static final String[] CAMERA = { BranchRefusals.VIDEO };
    private static final String[] MIC = { BranchRefusals.AUDIO };
    private static final String[] BOTH = { BranchRefusals.VIDEO, BranchRefusals.AUDIO };

    @Test
    public void aRefusedCameraOrMicrophoneIsTurnedAwayFromBranchsPage() {
        List<String> never = Arrays.asList("camera", "listen");
        assertFalse(BranchRefusals.mayCapture(never, CAMERA, false));
        assertFalse(BranchRefusals.mayCapture(never, MIC, false));
        assertFalse(BranchRefusals.mayCapture(Collections.singletonList("camera"), BOTH, false));
        assertFalse(BranchRefusals.mayCapture(Collections.singletonList("listen"), BOTH, false));
    }

    @Test
    public void nothingRefusedMeansNothingChanges() {
        assertTrue(BranchRefusals.mayCapture(Collections.emptyList(), BOTH, false));
        assertTrue(BranchRefusals.mayCapture(Collections.singletonList("camera"), MIC, false));
        assertTrue(BranchRefusals.mayCapture(Arrays.asList("screen", "run"), BOTH, false));
    }

    @Test
    public void thePhoneAppsOwnPageKeepsItsScannerAndTalkButton() {
        assertTrue(BranchRefusals.mayCapture(Arrays.asList("camera", "listen"), BOTH, true));
    }

    @Test
    public void onlyTheAppsOwnOriginCountsAsItsOwnPage() {
        assertTrue(BranchRefusals.sameOrigin("https://localhost", "https://localhost/"));
        assertTrue(BranchRefusals.sameOrigin("https://localhost/", "https://localhost/"));
        assertFalse(BranchRefusals.sameOrigin("https://localhost.evil.example", "https://localhost/"));
        assertFalse(BranchRefusals.sameOrigin("http://localhost", "https://localhost/"));
        assertFalse(BranchRefusals.sameOrigin("http://100.64.0.1:3210", "https://localhost/"));
        assertFalse(BranchRefusals.sameOrigin("null", "https://localhost/"));
    }
}
