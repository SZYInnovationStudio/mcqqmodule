package dev.szydmc.chatbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.papermc.paper.event.player.AsyncChatEvent;
import java.io.File;
import java.io.RandomAccessFile;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicBoolean;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Bukkit;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

public final class ChatBridgePlugin extends JavaPlugin implements Listener {
    private record OutgoingLine(String id, String kind, String player, String message, List<String> players) {}
    private record LogBatch(long start, long end, List<String> lines) {}
    private static final Map<String, NamedTextColor> COLORS = Map.ofEntries(
        Map.entry("black", NamedTextColor.BLACK), Map.entry("dark_blue", NamedTextColor.DARK_BLUE),
        Map.entry("dark_green", NamedTextColor.DARK_GREEN), Map.entry("dark_aqua", NamedTextColor.DARK_AQUA),
        Map.entry("dark_red", NamedTextColor.DARK_RED), Map.entry("dark_purple", NamedTextColor.DARK_PURPLE),
        Map.entry("gold", NamedTextColor.GOLD), Map.entry("gray", NamedTextColor.GRAY),
        Map.entry("dark_gray", NamedTextColor.DARK_GRAY), Map.entry("blue", NamedTextColor.BLUE),
        Map.entry("green", NamedTextColor.GREEN), Map.entry("aqua", NamedTextColor.AQUA),
        Map.entry("red", NamedTextColor.RED), Map.entry("light_purple", NamedTextColor.LIGHT_PURPLE),
        Map.entry("yellow", NamedTextColor.YELLOW), Map.entry("white", NamedTextColor.WHITE)
    );
    private final ConcurrentLinkedQueue<OutgoingLine> pending = new ConcurrentLinkedQueue<>();
    private final AtomicLong sequence = new AtomicLong();
    private final AtomicBoolean polling = new AtomicBoolean();
    private final String runId = UUID.randomUUID().toString().replace("-", "");
    private HttpClient http;
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
        http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        Bukkit.getPluginManager().registerEvents(this, this);
        queue("start", "", "", List.of());
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::poll, 20L, 20L);
        getLogger().info("聊天桥接已启用；插件主动连接网页程序，不开放新的 MC 端口。");
    }

    @Override public void onDisable() {
        if (task != null) task.cancel();
        sendLifecycleNow("stop");
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlayerChat(AsyncChatEvent event) {
        String player = event.getPlayer().getName();
        String message = PlainTextComponentSerializer.plainText().serialize(event.message()).trim();
        if (message.isEmpty() || !player.matches("[A-Za-z0-9_]{3,16}")) return;
        queue("chat", player, message.substring(0, Math.min(350, message.length())), List.of());
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
        return List.copyOf(players);
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
            request.addProperty("pluginVersion", getPluginMeta().getVersion());
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
            HttpRequest httpRequest = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(8)).header("Authorization", "Bearer " + key)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(request.toString())).build();
            HttpResponse<String> response = http.send(httpRequest, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) throw new IllegalStateException("平台 HTTP " + response.statusCode());
            JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
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
                Component text = render(item.getAsJsonArray("components"));
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
                String reason = cause.getClass().getSimpleName() + (detail == null || detail.isBlank() ? "" : "：" + detail);
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
            if (start >= size) return new LogBatch(start, start, List.of());
            int amount = (int)Math.min(65536, size - start);
            byte[] bytes = new byte[amount];
            int read;
            try (RandomAccessFile file = new RandomAccessFile(serverLogFile, "r")) {
                file.seek(start);
                read = file.read(bytes);
            }
            if (read <= 0) return new LogBatch(start, start, List.of());
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
                if (read < 65536) return new LogBatch(start, start, List.of());
                usable = read;
            }
            String text = new String(bytes, 0, usable, StandardCharsets.UTF_8);
            List<String> lines = new ArrayList<>();
            for (String line : text.split("\\r?\\n")) {
                if (line.isEmpty()) continue;
                lines.add(line.substring(0, Math.min(1000, line.length())));
                if (lines.size() == 200) break;
            }
            return new LogBatch(start, start + usable, List.copyOf(lines));
        } catch (Exception error) {
            return null;
        }
    }

    private void sendLifecycleNow(String kind) {
        if (http == null || endpoint == null || key == null || key.isBlank()) return;
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
            HttpRequest httpRequest = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(3)).header("Authorization", "Bearer " + key)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(request.toString())).build();
            http.send(httpRequest, HttpResponse.BodyHandlers.discarding());
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

    private Component render(JsonArray components) {
        Component result = Component.empty();
        for (JsonElement element : components) {
            JsonObject item = element.getAsJsonObject();
            String value = item.get("text").getAsString();
            if (value.length() > 512) continue;
            Component part = Component.text(value);
            if (item.has("color")) part = part.color(COLORS.getOrDefault(item.get("color").getAsString(), NamedTextColor.WHITE));
            if (item.has("bold")) part = part.decoration(TextDecoration.BOLD, true);
            if (item.has("italic")) part = part.decoration(TextDecoration.ITALIC, true);
            if (item.has("underlined")) part = part.decoration(TextDecoration.UNDERLINED, true);
            if (item.has("strikethrough")) part = part.decoration(TextDecoration.STRIKETHROUGH, true);
            if (item.has("obfuscated")) part = part.decoration(TextDecoration.OBFUSCATED, true);
            result = result.append(part);
        }
        return result;
    }
}
