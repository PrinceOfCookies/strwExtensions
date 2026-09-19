const DEFAULTS = {
  apiUrl: "http://localhost:9000/",
  ytdlpUrl: "http://localhost:9100/",
  videoQuality: "1080",
  videoCodec: "h264",
  ytdlpHosts: ["youtube.com", "youtu.be", "instagram.com"],
  apiKey: ""
};

const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  $("apiUrl").value = cfg.apiUrl;
  $("ytdlpUrl").value = cfg.ytdlpUrl;
  $("videoQuality").value = cfg.videoQuality;
  $("videoCodec").value = cfg.videoCodec;
  $("ytdlpHosts").value = (cfg.ytdlpHosts || []).join("\n");
  $("apiKey").value = cfg.apiKey;
});

$("save").addEventListener("click", () => {
  let apiUrl = $("apiUrl").value.trim();
  if (apiUrl && !apiUrl.endsWith("/")) apiUrl += "/";

  let ytdlpUrl = $("ytdlpUrl").value.trim();
  if (ytdlpUrl && !ytdlpUrl.endsWith("/")) ytdlpUrl += "/";

  chrome.storage.sync.set(
    {
      apiUrl: apiUrl || DEFAULTS.apiUrl,
      ytdlpUrl: ytdlpUrl,
      videoQuality: $("videoQuality").value,
      videoCodec: $("videoCodec").value,
      ytdlpHosts: $("ytdlpHosts").value
        .split("\n")
        .map((l) => l.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter(Boolean),
      apiKey: $("apiKey").value.trim()
    },
    () => {
      $("status").textContent = "saved";
      setTimeout(() => ($("status").textContent = ""), 1500);
    }
  );
});
