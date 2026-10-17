// Katalog veri modeli: v1 → v2 dönüşümü, doğrulama ve uygulamayla aynı JSON biçimi.
// Python tarafındaki core/models.py ile birebir aynı kuralları uygular.

export const PLATFORMS = [
  { key: "windows", label: "Windows", icon: "desktop_windows" },
  { key: "linux", label: "Linux", icon: "terminal" },
  { key: "macos", label: "macOS", icon: "laptop_mac" },
  { key: "android", label: "Android", icon: "android" },
];

export const STATUSES = { upcoming: "Yakında", released: "Yayında", archived: "Arşiv" };
export const CATEGORIES = { app: "Uygulama", game: "Oyun" };

// core/models.py InstallKind ile aynı. CLD Hub otomatik güncellemede dosyayı buna göre kurar.
export const KINDS = {
  "": "Otomatik (dosya adından)",
  file: "Tek dosya (taşınabilir)",
  zip: "ZIP (klasöre açılır)",
  inno: "Inno Setup kurulumu",
  apk: "Android paketi (APK)",
};

/** Dosya adından kurulum tipi tahmini; "Son sürümden doldur" kullanır. */
export function guessKind(filename) {
  const name = filename.toLowerCase();
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".apk")) return "apk";
  if (name.endsWith(".exe") && /setup|install/.test(name)) return "inno";
  return "file";
}

const normalizeSha = (value) => String(value || "").trim().toLowerCase().replace(/^sha256:/, "");

function normalizeDownload(value) {
  const entry = typeof value === "string" ? { url: value } : value || {};
  if (!entry.url) return null;
  return {
    url: entry.url, size_mb: Number(entry.size_mb) || 0,
    sha256: normalizeSha(entry.sha256), kind: KINDS[entry.kind] && entry.kind ? entry.kind : "",
  };
}

// Masaüstü uygulamasındaki ui/components/common.py ICON_MAP ile eşleşir.
export const ICONS = {
  default: "apps",
  media_kit: "video_library",
  password_gen: "password",
  notes: "note_alt",
  calculator: "calculate",
  game_puzzle: "extension",
  game_adventure: "explore",
  game_strategy: "psychology",
  browser: "language",
  chat: "chat",
  music: "music_note",
  photo: "photo_camera",
  file_manager: "folder",
  tools: "build",
  security: "security",
};

export function emptyApp() {
  return {
    id: "", name: "", description_tr: "", description_en: "",
    category: "app", status: "upcoming", version: "", github_repo: "",
    icon: "default", platforms: [], release_date: "", downloads: {}, featured: false,
    changelog: { tr: "", en: "" }, screenshots: [], hidden: false,
  };
}

/** Ham katalog kaydını (v1 veya v2) düzenlenebilir v2 nesnesine çevirir. */
export function normalizeApp(raw) {
  const app = { ...emptyApp(), ...raw };
  const downloads = {};
  for (const [platform, value] of Object.entries(raw.downloads || {})) {
    const entry = normalizeDownload(value);
    if (entry) downloads[platform] = entry;
  }
  if (!Object.keys(downloads).length && raw.download_url) {
    for (const platform of raw.platforms?.length ? raw.platforms : ["windows"]) {
      downloads[platform] = normalizeDownload({ url: raw.download_url, size_mb: raw.size_mb });
    }
  }
  app.downloads = downloads;
  app.platforms = raw.platforms?.length ? [...raw.platforms] : Object.keys(downloads);
  app.featured = Boolean(raw.featured);
  app.hidden = Boolean(raw.hidden);
  app.changelog = { tr: "", en: "", ...(raw.changelog || {}) };
  app.screenshots = Array.isArray(raw.screenshots) ? raw.screenshots.filter((u) => typeof u === "string" && u) : [];
  delete app.download_url;
  delete app.size_mb;
  return app;
}

/** Uygulamanın okuduğu JSON biçimine çevirir (alan sırası core/models.py ile aynı). */
export function serializeApp(app) {
  const out = { id: app.id, name: app.name };
  for (const key of Object.keys(app).filter((k) => k.startsWith("description_")).sort()) {
    if (app[key]) out[key] = app[key];
  }
  Object.assign(out, {
    category: app.category,
    status: app.status,
    version: app.version,
    github_repo: app.github_repo,
    icon: app.icon,
    platforms: app.platforms,
    release_date: app.release_date || "",
    downloads: Object.fromEntries(
      PLATFORMS.filter((p) => app.downloads[p.key]?.url).map((p) => {
        const d = app.downloads[p.key];
        const entry = { url: d.url };
        if (d.size_mb) entry.size_mb = d.size_mb;
        if (d.sha256) entry.sha256 = d.sha256;
        if (d.kind) entry.kind = d.kind;
        return [p.key, entry];
      })),
  });
  // Eski CLD Hub sürümleri yalnızca bu iki alanı okur.
  const legacy = app.downloads.windows;
  if (legacy?.url) {
    out.download_url = legacy.url;
    out.size_mb = legacy.size_mb || 0;
  }
  if (app.featured) out.featured = true;
  const changelog = Object.fromEntries(
    Object.entries(app.changelog || {}).filter(([, text]) => text && text.trim()));
  if (Object.keys(changelog).length) out.changelog = changelog;
  if (app.screenshots?.length) out.screenshots = [...app.screenshots];
  if (app.hidden) out.hidden = true;
  return out;
}

// Panelin tanımadığı üst düzey alanlar (ör. stats_url) olduğu gibi korunur.
const MANAGED_KEYS = new Set(["catalog_version", "last_updated", "catalog_url", "apps"]);

export function parseCatalog(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`catalog.json geçerli bir JSON değil: ${err.message}`);
  }
  if (!data || !Array.isArray(data.apps)) throw new Error("catalog.json içinde 'apps' listesi yok.");
  return {
    catalog_url: data.catalog_url || "",
    extra: Object.fromEntries(Object.entries(data).filter(([key]) => !MANAGED_KEYS.has(key))),
    apps: data.apps.filter((a) => a && a.id).map(normalizeApp),
  };
}

export function serializeCatalog(catalog) {
  const data = {
    catalog_version: "2.1",
    last_updated: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    catalog_url: catalog.catalog_url,
    ...(catalog.extra || {}),
    apps: catalog.apps.map(serializeApp),
  };
  return JSON.stringify(data, null, 2) + "\n";
}

/** Değişiklik tespiti için zaman damgasından bağımsız karşılaştırma anahtarı. */
export function fingerprint(app) {
  return JSON.stringify(serializeApp(app));
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Alan adı → hata mesajı sözlüğü döner; boşsa kayıt geçerlidir. */
export function validateApp(app, allApps, originalId = null) {
  const errors = {};
  if (!app.id) errors.id = "ID zorunlu.";
  else if (!ID_PATTERN.test(app.id)) errors.id = "Yalnızca harf, rakam, tire ve alt çizgi kullan.";
  else if (app.id !== originalId && allApps.some((a) => a.id === app.id)) errors.id = "Bu ID zaten kullanılıyor.";

  if (!app.name.trim()) errors.name = "Ad zorunlu.";
  if (app.status !== "upcoming" && !app.version.trim()) errors.version = "Yayındaki bir uygulamanın sürümü olmalı.";
  if (app.release_date && !DATE_PATTERN.test(app.release_date)) errors.release_date = "Tarih YYYY-AA-GG biçiminde olmalı.";
  if (app.github_repo && !REPO_PATTERN.test(app.github_repo)) errors.github_repo = "'kullanıcı/repo' biçiminde yaz.";

  for (const { key, label } of PLATFORMS) {
    const d = app.downloads[key];
    if (!d) continue;
    if (d.url && !isHttpUrl(d.url)) errors[`dl_${key}`] = `${label} bağlantısı geçerli bir URL değil.`;
    if (d.size_mb < 0) errors[`dl_${key}`] = `${label} boyutu negatif olamaz.`;
    if (d.sha256 && !SHA_PATTERN.test(d.sha256)) errors[`sha_${key}`] = "64 karakterlik bir SHA-256 değeri olmalı.";
    if (d.kind === "apk" && key !== "android") errors[`kind_${key}`] = "APK yalnızca Android için.";
    if (key === "android" && d.kind && d.kind !== "apk") errors[`kind_${key}`] = "Android'de yalnızca APK kurulabilir.";
  }
  const badShot = (app.screenshots || []).find((url) => !isHttpUrl(url));
  if (badShot) errors.screenshots = `Geçerli bir URL değil: ${badShot}`;
  if (app.status === "released" && !Object.values(app.downloads).some((d) => d.url)) {
    errors.downloads = "Yayındaki bir uygulamanın en az bir indirme bağlantısı olmalı.";
  }
  return errors;
}

/** Dosya adından platform tahmini (sürüm dosyalarını otomatik eşlemek için). */
export function guessPlatform(filename) {
  const name = filename.toLowerCase();
  if (name.endsWith(".apk") || name.endsWith(".aab") || name.includes("android")) return "android";
  if (name.endsWith(".dmg") || name.endsWith(".pkg") || /mac|darwin|osx/.test(name)) return "macos";
  if (/\.(appimage|deb|rpm|flatpak|snap)$/.test(name) || name.includes("linux")) return "linux";
  if (/\.(exe|msi|msix)$/.test(name) || /win(dows)?(32|64)?/.test(name)) return "windows";
  return null;
}
