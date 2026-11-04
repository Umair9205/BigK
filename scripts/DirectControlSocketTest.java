package com.anonymous.kelakonnect;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real TCP loopback tests for the production helper. No phone/radio claims. */
public final class DirectControlSocketTest {
    static final InetAddress LOCAL = InetAddress.getLoopbackAddress();
    static final String AUTH = "session|" + "a".repeat(64);
    static int passed;
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    static void pass(String name) { passed++; System.out.println("PASS " + name); }

    static final class Host implements AutoCloseable {
        final AtomicBoolean active = new AtomicBoolean(true);
        final AtomicReference<ServerSocket> server = new AtomicReference<>();
        final AtomicReference<Socket> socket = new AtomicReference<>();
        final CountDownLatch listening = new CountDownLatch(1);
        final List<String> stages = new CopyOnWriteArrayList<>();
        final ExecutorService executor = Executors.newSingleThreadExecutor();
        final Future<DirectControlSocket.Connection> result;
        final int port;
        Host(boolean closeFirstListener) throws Exception {
            try (ServerSocket probe = new ServerSocket(0, 1, LOCAL)) { port = probe.getLocalPort(); }
            AtomicBoolean first = new AtomicBoolean(closeFirstListener);
            result = executor.submit(() -> DirectControlSocket.accept(LOCAL, port, AUTH,
                DirectControlSocket.now() + 5000, active::get, server::set, socket::set, stage -> {
                    stages.add(stage);
                    if (stage.equals("listening")) {
                        if (first.getAndSet(false)) {
                            try { server.get().close(); } catch (IOException e) { throw new RuntimeException(e); }
                        } else listening.countDown();
                    }
                }));
            check(listening.await(3, TimeUnit.SECONDS), "Listener did not start");
        }
        DirectControlSocket.Connection client() throws Exception {
            return DirectControlSocket.connect(LOCAL, LOCAL, port, AUTH,
                DirectControlSocket.now() + 3000, active::get, ignored -> {}, ignored -> {});
        }
        public void close() throws Exception {
            active.set(false);
            if (socket.get() != null) socket.get().close();
            if (server.get() != null) server.get().close();
            executor.shutdownNow();
            check(executor.awaitTermination(3, TimeUnit.SECONDS), "Socket worker leaked");
        }
    }

    public static void main(String[] args) throws Exception {
        try (Host host = new Host(false)) {
            DirectControlSocket.Connection client = host.client();
            try (Socket c = client.socket; Socket s = host.result.get(3, TimeUnit.SECONDS).socket) {
                check(c.getLocalAddress().equals(LOCAL), "Wrong local interface");
                DirectControlSocket.Connection peer = host.result.get();
                client.writer.write("offer\n"); client.writer.flush();
                check("offer".equals(DirectControlSocket.readLine(peer.reader, 100)), "Offer lost");
                peer.writer.write("answer\n"); peer.writer.flush();
                check("answer".equals(DirectControlSocket.readLine(client.reader, 100)), "Answer lost");
            }
            pass("authenticated control exchanges messages with an explicitly bound source");
        }
        try (Host host = new Host(false)) {
            try (Socket bad = new Socket(LOCAL, host.port)) {
                bad.setSoTimeout(2000);
                bad.getOutputStream().write("wrong-token\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
                check(bad.getInputStream().read() == -1, "Bad token was accepted");
            }
            DirectControlSocket.Connection client = host.client();
            try (Socket c = client.socket; Socket s = host.result.get(3, TimeUnit.SECONDS).socket) {
                check(host.stages.contains("authentication-rejected"), "Missing auth rejection");
            }
            pass("invalid peer does not close the listener for the valid peer");
        }
        try (Host host = new Host(true)) {
            DirectControlSocket.Connection client = host.client();
            try (Socket c = client.socket; Socket s = host.result.get(3, TimeUnit.SECONDS).socket) {
                check(host.stages.stream().anyMatch(x -> x.startsWith("listener-retry:")), "Listener was not rebound");
            }
            pass("unexpected listener closure is rebound before authentication");
        }
        try (Host host = new Host(false); Socket partial = new Socket(LOCAL, host.port)) {
            partial.getOutputStream().write('s');
            long deadline = DirectControlSocket.now() + 2000;
            while (host.socket.get() == null && DirectControlSocket.now() < deadline) Thread.sleep(10);
            check(host.socket.get() != null, "Peer was not accepted");
            host.active.set(false); host.socket.get().close(); host.server.get().close();
            try { host.result.get(2, TimeUnit.SECONDS); throw new AssertionError("Cancellation succeeded as a call"); }
            catch (ExecutionException expected) { check(expected.getCause() instanceof InterruptedIOException, "Cancellation lost its cause"); }
            pass("cancellation closes an accepted peer stalled during authentication");
        }
        AtomicReference<Socket> rejected = new AtomicReference<>();
        int unusedPort;
        try (ServerSocket probe = new ServerSocket(0, 1, LOCAL)) { unusedPort = probe.getLocalPort(); }
        try {
            DirectControlSocket.connect(LOCAL, LOCAL, unusedPort, AUTH,
                DirectControlSocket.now() + 250, () -> true, rejected::set, ignored -> {});
            throw new AssertionError("Unreachable peer connected");
        } catch (IOException expected) {
            check(expected.getCause() != null, "Original connection cause was discarded");
            check(rejected.get().isClosed(), "Failed socket leaked");
        }
        pass("unreachable peer has a bounded deadline and preserves the connection cause");
        check("abc".equals(DirectControlSocket.readLine(new BufferedReader(new StringReader("abc\n")), 3)), "Exact bound failed");
        for (String input : new String[] {"abcd\n", "ab"}) {
            try { DirectControlSocket.readLine(new BufferedReader(new StringReader(input)), 3); throw new AssertionError("Invalid frame accepted"); }
            catch (IOException expected) { }
        }
        pass("control frames reject oversize and truncated input");
        DirectLinkHealth health = new DirectLinkHealth();
        check(!health.absent(0) && !health.absent(1400), "Transient absence ended the call");
        health.present();
        check(!health.absent(2000) && !health.absent(3499) && health.absent(3500), "Continuous absence was not confirmed");
        health.present(); check(!health.absent(4000), "Recovery did not reset the loss window");
        pass("brief missing-group reports recover; sustained absence ends the call");
        System.out.println(passed + " native control tests passed");
    }
}
