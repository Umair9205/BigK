package com.anonymous.kelakonnect;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Authenticated control only. Audio stays in WebRTC. No Android dependency so the
 * actual socket/handshake code can be exercised on the JVM, not just mocked in JS. */
public final class DirectControlSocket {
    private DirectControlSocket() {}

    public static final class Connection {
        public final Socket socket;
        public final BufferedReader reader;
        public final BufferedWriter writer;
        Connection(Socket socket) throws IOException {
            this.socket = socket;
            reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }
    }

    public static long now() { return System.nanoTime() / 1_000_000L; }

    public static String readLine(BufferedReader reader, int max) throws IOException {
        StringBuilder line = new StringBuilder();
        while (true) {
            int c = reader.read();
            if (c == -1) {
                if (line.length() != 0) throw new EOFException("Incomplete control message");
                return null;
            }
            if (c == '\n') return line.toString();
            if (line.length() >= max) throw new IOException("Control message too large");
            line.append((char)c);
        }
    }

    private static void configure(Socket socket, long deadline) throws IOException {
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);
        socket.setSoTimeout((int)Math.max(1, Math.min(1500, deadline - now())));
    }

    private static void pause(BooleanSupplier active) throws IOException {
        if (!active.getAsBoolean()) throw new InterruptedIOException("Call stopped");
        // Retry granularity on the critical path: the peer's listener can come
        // up between any two attempts, so do not sleep longer than needed.
        try { Thread.sleep(60); }
        catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new InterruptedIOException("Call stopped");
        }
    }

    public static Connection accept(InetAddress local, int port, String auth, long deadline,
            BooleanSupplier active, Consumer<ServerSocket> serverCreated,
            Consumer<Socket> socketCreated, Consumer<String> stage) throws IOException {
        IOException last = null;
        int listenerFailures = 0;
        while (active.getAsBoolean() && now() < deadline && listenerFailures < 4) {
            // Only listener errors reach this catch. Authentication failures must
            // not close the listener; errors AFTER authentication must not return
            // to accept() on an already-closed listener.
            try (ServerSocket server = new ServerSocket()) {
                serverCreated.accept(server);
                if (!active.getAsBoolean()) break;
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(local, port));
                server.setSoTimeout(250);
                stage.accept("listening");
                while (active.getAsBoolean() && now() < deadline) {
                    Socket socket;
                    try { socket = server.accept(); }
                    catch (SocketTimeoutException expected) { continue; }
                    boolean accepted = false;
                    try {
                        socketCreated.accept(socket);
                        if (!active.getAsBoolean()) break;
                        configure(socket, deadline);
                        stage.accept("authenticating");
                        Connection connection = new Connection(socket);
                        String received = readLine(connection.reader, 256);
                        if (received == null || !MessageDigest.isEqual(received.getBytes(StandardCharsets.UTF_8),
                                auth.getBytes(StandardCharsets.UTF_8))) {
                            stage.accept("authentication-rejected");
                            continue;
                        }
                        connection.writer.write("OK\n");
                        connection.writer.flush();
                        socket.setSoTimeout(0);
                        if (!active.getAsBoolean()) break;
                        accepted = true;
                        return connection;
                    } catch (IOException e) {
                        last = e;
                        stage.accept("handshake-retry:" + e.getClass().getSimpleName());
                    } finally {
                        if (!accepted) close(socket);
                    }
                }
            } catch (IOException e) {
                last = e;
                if (!active.getAsBoolean()) break;
                listenerFailures++;
                stage.accept("listener-retry:" + e.getClass().getSimpleName());
                pause(active);
            }
        }
        if (!active.getAsBoolean()) throw new InterruptedIOException("Call stopped");
        throw new IOException("Direct control listener could not authenticate a peer before its deadline" +
                (last == null ? "" : " (" + last.getClass().getSimpleName() + ")"), last);
    }

    public static Connection connect(InetAddress local, InetAddress owner, int port, String auth,
            long deadline, BooleanSupplier active, Consumer<Socket> socketCreated,
            Consumer<String> stage) throws IOException {
        IOException last = null;
        while (active.getAsBoolean() && now() < deadline) {
            Socket socket = new Socket();
            boolean accepted = false;
            try {
                socketCreated.accept(socket);
                if (!active.getAsBoolean()) break;
                configure(socket, deadline);
                // Never allow Android's current default router/mobile interface
                // to select the source of this Wi-Fi Direct control connection.
                socket.bind(new InetSocketAddress(local, 0));
                socket.connect(new InetSocketAddress(owner, port),
                        (int)Math.max(1, Math.min(1000, deadline - now())));
                stage.accept("authenticating");
                Connection connection = new Connection(socket);
                connection.writer.write(auth + "\n");
                connection.writer.flush();
                if (!"OK".equals(readLine(connection.reader, 32)))
                    throw new IOException("Peer authentication failed");
                socket.setSoTimeout(0);
                if (!active.getAsBoolean()) break;
                accepted = true;
                return connection;
            } catch (IOException e) {
                last = e;
                stage.accept("connect-retry:" + e.getClass().getSimpleName());
            } finally {
                if (!accepted) close(socket);
            }
            pause(active);
        }
        if (!active.getAsBoolean()) throw new InterruptedIOException("Call stopped");
        throw new IOException("Direct control peer was unreachable before its deadline" +
                (last == null ? "" : " (" + last.getClass().getSimpleName() + ")"), last);
    }

    private static void close(Socket socket) {
        try { socket.close(); } catch (IOException ignored) { }
    }
}
