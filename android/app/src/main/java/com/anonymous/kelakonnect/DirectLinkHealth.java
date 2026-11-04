package com.anonymous.kelakonnect;

/** Main-thread only. One absent framework snapshot is not a confirmed link loss. */
public final class DirectLinkHealth {
    private long absentAt = -1;
    public void present() { absentAt = -1; }
    public boolean absent(long now) {
        if (absentAt < 0) absentAt = now;
        return now - absentAt >= 1500;
    }
}
