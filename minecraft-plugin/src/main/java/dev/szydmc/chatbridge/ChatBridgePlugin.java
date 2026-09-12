package dev.szydmc.chatbridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.papermc.paper.event.player.AsyncChatEvent;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
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
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

public final class ChatBridgePlugin extends JavaPlugin implements Listener {
    private record ChatLine(String id, String player, String message) {}
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
    private final ConcurrentLinkedQueue<ChatLine> pending = new ConcurrentLinkedQueue<>();
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

    @Override public void onEnable() {
        saveDefaultConfig();
        key = getConfig().getString("key", "").trim();
        String url = getConfig().getString("bridge-url", "");
        try {
            endpoint = URI.create(url);
            boolean loopback = "127.0.0.1".equals(endpoint.getHost()) || "localhost".equalsIgnoreCase(endpoint.getHost()) || "::1".equals(endpoint.getHost());
            if (!("https".equals(endpoint.getScheme()) || ("http".equals(endpoint.getScheme()) && loopback)) || !"/api/plugin/exchange".equals(endpoint.getPath())) throw new IllegalArgumentException("远程地址必须使用 HTTPS；本机可用 HTTP 127.0.0.1");
            if (!key.matches("[A-Za-z0-9_-]{32,128}")) throw new IllegalArgumentException("请在 plugins/SZYDMCChatBridge/config.yml 填写至少 32 位的插件 Key");
        } catch (IllegalArgumentException error) {
            getLogger().severe("聊天桥接未启用：" + error.getMessage());
            return;
        }
        http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        Bukkit.getPluginManager().registerEvents(this, this);
        task = Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::poll, 20L, 20L);
        getLogger().info("聊天桥接已启用；插件主动连接网页程序，不开放新的 MC 端口。");
    }

    @Override public void onDisable() {
        if (task != null) task.cancel();
    }

    @EventHandler(ignoreCancelled = true)
    public void onPlayerChat(AsyncChatEvent event) {
        String player = event.getPlayer().getName();
        String message = PlainTextComponentSerializer.plainText().serialize(event.message()).trim();
        if (message.isEmpty() || !player.matches("[A-Za-z0-9_]{3,16}")) return;
        while (pending.size() >= 100) pending.poll();
        pending.add(new ChatLine(runId + "-" + sequence.incrementAndGet(), player, message.substring(0, Math.min(350, message.length()))));
    }

    private void poll() {
        if (!isEnabled() || !polling.compareAndSet(false, true)) return;
        try {
            List<ChatLine> batch = new ArrayList<>();
            for (ChatLine line : pending) { if (batch.size() == 20) break; batch.add(line); }
            JsonObject request = new JsonObject();
            request.addProperty("ack", lastAck);
            request.addProperty("epoch", epoch);
            JsonArray sent = new JsonArray();
            for (ChatLine line : batch) {
                JsonObject item = new JsonObject();
                item.addProperty("id", line.id()); item.addProperty("player", line.player()); item.addProperty("message", line.message());
                sent.add(item);
            }
            request.add("sent", sent);
            HttpRequest httpRequest = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(8)).header("Authorization", "Bearer " + key)
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(request.toString())).build();
            HttpResponse<String> response = http.send(httpRequest, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) throw new IllegalStateException("平台 HTTP " + response.statusCode());
            JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
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
            for (ChatLine line : batch) pending.remove(line);
        } catch (Exception error) {
            long now = System.currentTimeMillis();
            if (now - lastWarn > 30000) { getLogger().warning("平台聊天接口暂不可用：" + error.getMessage()); lastWarn = now; }
        } finally { polling.set(false); }
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
