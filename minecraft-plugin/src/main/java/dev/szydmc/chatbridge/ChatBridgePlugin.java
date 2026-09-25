package dev.szydmc.chatbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

public final class ChatBridgePlugin extends JavaPlugin implements Listener {
    private static final class OutgoingLine {
        private final String id;
        private final String kind;
        private final String player;
        private final String message;
        private final List<String> players;
        private OutgoingLine(String id, String kind, String player, String message, List<String> players) {
            this.id = id; this.kind = kind; this.player = player; this.message = message; this.players = players;
        }
        private String id() { return id; }
        private String kind() { return kind; }
        private String player() { return player; }
        private String message() { return message; }
        private List<String> players() { return players; }
    }
    private static final class LogBatch {
        private final long start;
        private final long end;
        private final List<String> lines;
        private LogBatch(long start, long end, List<String> lines) { this.start = start; this.end = end; this.lines = lines; }
        private long start() { return start; }
        private long end() { return end; }
        private List<String> lines() { return lines; }
    }
    private static final Map<String, ChatColor> COLORS = new HashMap<String, ChatColor>();
    static {
        COLORS.put("black", ChatColor.BLACK); COLORS.put("dark_blue", ChatColor.DARK_BLUE);
        COLORS.put("dark_green", ChatColor.DARK_GREEN); COLORS.put("dark_aqua", ChatColor.DARK_AQUA);
        COLORS.put("dark_red", ChatColor.DARK_RED); COLORS.put("dark_purple", ChatColor.DARK_PURPLE);
        COLORS.put("gold", ChatColor.GOLD); COLORS.put("gray", ChatColor.GRAY);
        COLORS.put("dark_gray", ChatColor.DARK_GRAY); COLORS.put("blue", ChatColor.BLUE);
        COLORS.put("green", ChatColor.GREEN); COLORS.put("aqua", ChatColor.AQUA);
        COLORS.put("red", ChatColor.RED); COLORS.put("light_purple", ChatColor.LIGHT_PURPLE);
        COLORS.put("yellow", ChatColor.YELLOW); COLORS.put("white", ChatColor.WHITE);
    }
    private final ConcurrentLinkedQueue<OutgoingLine> pending = new ConcurrentLinkedQueue<>();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicBoolean polling = new AtomicBoolean();
    private final String runId = UUID.randomUUID().toString().replace("-", "");
    private URI endpoint;
    private String key;
    private String epoch = "";
    private long lastAck;
    private long lastWarn;
    private BukkitTask task;
    private File aqqbotDataFile;
    private File serverLogFile;
    private long serverLogPosition;
    private String serverLogFileKey = "";
    private boolean serverLogInitialized;
    private volatile boolean serverLogEnabled;

    @Override public void onEnable() {
        saveDefaultConfig();
        key = getConfig().getString("key", "").trim();
        String url = getConfig().getString("bridge-url", "");
        try {
            endpoint = URI.create(url);
            boolean loopback = "127.0.0.1".equals(endpoint.getHost());
            if (!("https".equals(endpoint.getScheme()) || ("http".equals(endpoint.getScheme()) && loopback)) || !"/api/plugin/exchange".equals(endpoint.getPath())) throw new IllegalArgumentException("远程地址必须使用 HTTPS；本机可用 HTTP 127.0.0.1");
            if (!key.matches("[A-Za-z0-9_-]{32,128}")) throw new IllegalArgumentException("请在 plugins/SZYDMCChatBridge/config.yml 填写至少 32 位的插件 Key");
        } catch (IllegalArgumentException error) {
            getLogger().severe("聊天桥接未启用：" + error.getMessage());
            return;
        }
        String dataPath = getConfig().getString("aqqbot-data-path", "../AQQBot/data.yml");
        aqqbotDataFile = new File(dataPath).isAbsolute() ? new File(dataPath) : new File(getDataFolder(), dataPath);
        String logPath = getConfig().getString("server-log-path", "../../logs/latest.log");
        serverLogFile = new File(logPath).isAbsolute() ? new File(logPath) : new File(getDataFolder(), logPath);
        Bukkit.getPluginManager().registerEvents(this, this);
        queue("start", "", "", Collections.<String>emptyList());
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::poll, 20L, 20L);
        getLogger().info("聊天桥接已启用；插件主动连接网页程序，不开放新的 MC 端口。");
    }

    @Override public void onDisable() {
        if (task != null) task.cancel();
        sendLifecycleNow("stop");
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlayerChat(AsyncPlayerChatEvent event) {
        String player = event.getPlayer().getName();
        String message = event.getMessage().trim();
        if (message.isEmpty() || !player.matches("[A-Za-z0-9_]{3,16}")) return;
        queue("chat", player, message.substring(0, Math.min(350, message.length())), Collections.<String>emptyList());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerJoin(PlayerJoinEvent event) {
        String player = event.getPlayer().getName();
        List<String> players = onlinePlayers(player, true);
        queue("join", player, "", players);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerQuit(PlayerQuitEvent event) {
        String player = event.getPlayer().getName();
        List<String> players = onlinePlayers(player, false);
        queue("quit", player, "", players);
    }

    private List<String> onlinePlayers(String subject, boolean joined) {
        List<String> players = new ArrayList<>();
        Bukkit.getOnlinePlayers().forEach(player -> {
            if (!player.getName().equalsIgnoreCase(subject)) players.add(player.getName());
        });
        if (joined) players.add(subject);
        players.sort(String.CASE_INSENSITIVE_ORDER);
        return Collections.unmodifiableList(new ArrayList<String>(players));
    }

    private void queue(String kind, String player, String message, List<String> players) {
        while (pending.size() >= 100) pending.poll();
        pending.add(new OutgoingLine(runId + "-" + sequence.incrementAndGet(), kind, player, message, players));
    }

    private void poll() {
        if (!isEnabled() || !polling.compareAndSet(false, true)) return;
        try {
            List<OutgoingLine> batch = new ArrayList<>();
            for (OutgoingLine line : pending) { if (batch.size() == 20) break; batch.add(line); }
            JsonObject request = new JsonObject();
            request.addProperty("ack", lastAck);
            request.addProperty("epoch", epoch);
            request.addProperty("pluginVersion", getDescription().getVersion());
            JsonArray sent = new JsonArray();
            for (OutgoingLine line : batch) {
                JsonObject item = new JsonObject();
                item.addProperty("id", line.id()); item.addProperty("kind", line.kind()); item.addProperty("player", line.player());
                if ("chat".equals(line.kind())) item.addProperty("message", line.message());
                else {
                    JsonArray players = new JsonArray();
                    line.players().forEach(players::add);
                    item.add("players", players);
                }
                sent.add(item);
            }
            request.add("sent", sent);
            request.add("aqqbotSnapshot", readAqqbotSnapshot());
            LogBatch logBatch = serverLogEnabled ? readServerLogBatch() : null;
            if (logBatch != null && !logBatch.lines().isEmpty()) {
                JsonObject logs = new JsonObject();
                logs.addProperty("source", runId);
                logs.addProperty("start", logBatch.start());
                logs.addProperty("end", logBatch.end());
                JsonArray lines = new JsonArray();
                logBatch.lines().forEach(lines::add);
                logs.add("lines", lines);
                request.add("serverLogs", logs);
            }
            JsonObject body = JsonParser.parseString(post(request, 8000, true)).getAsJsonObject();
            boolean nextLogEnabled = body.has("logEnabled") && body.get("logEnabled").getAsBoolean();
            if (serverLogEnabled && logBatch != null) serverLogPosition = logBatch.end();
            if (!nextLogEnabled) serverLogInitialized = false;
            serverLogEnabled = nextLogEnabled;
            String returnedEpoch = body.get("epoch").getAsString();
            if (!returnedEpoch.equals(epoch)) { epoch = returnedEpoch; lastAck = 0; }
            for (JsonElement element : body.getAsJsonArray("receive")) {
                JsonObject item = element.getAsJsonObject();
                long id = item.get("id").getAsLong();
                if (id <= lastAck) continue;
                String text = render(item.getAsJsonArray("components"));
                Bukkit.getScheduler().runTask(this, () -> Bukkit.getOnlinePlayers().forEach(player -> player.sendMessage(text)));
                lastAck = id;
            }
            for (OutgoingLine line : batch) pending.remove(line);
        } catch (Exception error) {
            long now = System.currentTimeMillis();
            if (now - lastWarn > 30000) {
                Throwable cause = error;
                while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
                String detail = cause.getMessage();
                String reason = cause.getClass().getSimpleName() + (detail == null || detail.trim().isEmpty() ? "" : "：" + detail);
                getLogger().warning("平台聊天接口暂不可用（" + endpoint.getHost() + ":" + endpoint.getPort() + "）：" + reason);
                lastWarn = now;
            }
        } finally { polling.set(false); }
    }

    private LogBatch readServerLogBatch() {
        if (serverLogFile == null || !serverLogFile.isFile()) return null;
        try {
            BasicFileAttributes attributes = Files.readAttributes(serverLogFile.toPath(), BasicFileAttributes.class);
            String fileKey = String.valueOf(attributes.fileKey());
            long size = attributes.size();
            if (!serverLogInitialized || size < serverLogPosition || (!serverLogFileKey.isEmpty() && !serverLogFileKey.equals(fileKey))) {
                serverLogPosition = Math.max(0, size - 262144);
                serverLogFileKey = fileKey;
                serverLogInitialized = true;
                if (serverLogPosition > 0) {
                    try (RandomAccessFile file = new RandomAccessFile(serverLogFile, "r")) {
                        file.seek(serverLogPosition);
                        while (file.getFilePointer() < size && file.read() != '\n') {}
                        serverLogPosition = file.getFilePointer();
                    }
                }
            }
            long start = serverLogPosition;
            if (start >= size) return new LogBatch(start, start, Collections.<String>emptyList());
            int amount = (int)Math.min(65536, size - start);
            byte[] bytes = new byte[amount];
            int read;
            try (RandomAccessFile file = new RandomAccessFile(serverLogFile, "r")) {
                file.seek(start);
                read = file.read(bytes);
            }
            if (read <= 0) return new LogBatch(start, start, Collections.<String>emptyList());
            int usable = -1;
            int lineCount = 0;
            for (int index = 0; index < read; index++) {
                if (bytes[index] == '\n') {
                    usable = index + 1;
                    lineCount++;
                    if (lineCount == 200) break;
                }
            }
            if (usable < 0) {
                if (read < 65536) return new LogBatch(start, start, Collections.<String>emptyList());
                usable = read;
            }
            String text = new String(bytes, 0, usable, StandardCharsets.UTF_8);
            List<String> lines = new ArrayList<>();
            for (String line : text.split("\\r?\\n")) {
                if (line.isEmpty()) continue;
                lines.add(line.substring(0, Math.min(1000, line.length())));
                if (lines.size() == 200) break;
            }
            return new LogBatch(start, start + usable, Collections.unmodifiableList(new ArrayList<String>(lines)));
        } catch (Exception error) {
            return null;
        }
    }

    private void sendLifecycleNow(String kind) {
        if (endpoint == null || key == null || key.trim().isEmpty()) return;
        try {
            JsonObject request = new JsonObject();
            request.addProperty("ack", lastAck);
            request.addProperty("epoch", epoch);
            JsonArray sent = new JsonArray();
            JsonObject item = new JsonObject();
            item.addProperty("id", runId + "-" + sequence.incrementAndGet());
            item.addProperty("kind", kind);
            sent.add(item);
            request.add("sent", sent);
            post(request, 3000, false);
        } catch (Exception error) {
            getLogger().warning("服务器关闭状态未能立即上报，后台将通过心跳超时判断。");
        }
    }

    private JsonObject readAqqbotSnapshot() {
        JsonObject snapshot = new JsonObject();
        snapshot.addProperty("capturedAt", System.currentTimeMillis());
        JsonArray rows = new JsonArray();
        snapshot.add("rows", rows);
        if (aqqbotDataFile == null || !aqqbotDataFile.isFile()) {
            snapshot.addProperty("available", false);
            snapshot.addProperty("reason", "未找到 AQQBot data.yml");
            return snapshot;
        }
        try {
            YamlConfiguration data = YamlConfiguration.loadConfiguration(aqqbotDataFile);
            int count = 0;
            for (String key : data.getKeys(false)) {
                if (count >= 5000 || !key.matches("\\d{5,20}")) continue;
                JsonObject row = new JsonObject();
                row.addProperty("qq", key);
                JsonArray players = new JsonArray();
                int playerCount = 0;
                for (String player : data.getStringList(key)) {
                    if (playerCount >= 100) break;
                    String clean = player.trim();
                    if (clean.matches("[A-Za-z0-9_]{3,16}")) {
                        players.add(clean);
                        playerCount++;
                    }
                }
                row.add("players", players);
                rows.add(row);
                count++;
            }
            snapshot.addProperty("available", true);
            return snapshot;
        } catch (Exception error) {
            snapshot.addProperty("available", false);
            snapshot.addProperty("reason", "读取 AQQBot data.yml 失败：" + error.getClass().getSimpleName());
            return snapshot;
        }
    }

    private String post(JsonObject request, int timeoutMillis, boolean readBody) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)endpoint.toURL().openConnection();
        connection.setConnectTimeout(Math.min(5000, timeoutMillis));
        connection.setReadTimeout(timeoutMillis);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Authorization", "Bearer " + key);
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        connection.setDoOutput(true);
        byte[] payload = request.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(payload.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(payload); }
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IllegalStateException("平台 HTTP " + status);
        }
        if (!readBody) { connection.disconnect(); return ""; }
        StringBuilder body = new StringBuilder();
        try (InputStream input = connection.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
        } finally { connection.disconnect(); }
        return body.toString();
    }

    private String render(JsonArray components) {
        StringBuilder result = new StringBuilder();
        for (JsonElement element : components) {
            JsonObject item = element.getAsJsonObject();
            String value = item.get("text").getAsString();
            if (value.length() > 512) continue;
            result.append(ChatColor.RESET);
            if (item.has("color")) {
                ChatColor color = COLORS.get(item.get("color").getAsString());
                result.append(color == null ? ChatColor.WHITE : color);
            }
            if (item.has("bold") && item.get("bold").getAsBoolean()) result.append(ChatColor.BOLD);
            if (item.has("italic") && item.get("italic").getAsBoolean()) result.append(ChatColor.ITALIC);
            if (item.has("underlined") && item.get("underlined").getAsBoolean()) result.append(ChatColor.UNDERLINE);
            if (item.has("strikethrough") && item.get("strikethrough").getAsBoolean()) result.append(ChatColor.STRIKETHROUGH);
            if (item.has("obfuscated") && item.get("obfuscated").getAsBoolean()) result.append(ChatColor.MAGIC);
            result.append(value);
        }
        return result.append(ChatColor.RESET).toString();
    }
}
