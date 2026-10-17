import { GitHubClient, GitHubError } from "./github.js";
import {
  CATEGORIES, ICONS, KINDS, PLATFORMS, STATUSES,
  emptyApp, fingerprint, guessKind, guessPlatform, parseCatalog, serializeCatalog, validateApp,
} from "./catalog.js";

const CONN_KEY = "cldhub_admin_connection";
const TOKEN_KEY = "cldhub_admin_token";

const state = {
  mode: null,            // "github" | "local"
  client: null,
  sha: null,
  catalog: null,         // { catalog_url, apps: [...] }
  baseline: new Map(),   // id → fingerprint (son yükleme/yayın anındaki hâli)
  filter: { query: "", category: "all", status: "all" },
  editing: null,         // { originalId, draft }
};

// ── DOM yardımcıları ─────────────────────────────────────────
// İçerik daima textContent ile eklenir; katalog verisi HTML olarak yorumlanmaz.

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const icon = (name) => h("span", { class: "icon", "aria-hidden": "true" }, name);

function toast(message, type = "info", link = null) {
  const icons = { info: "info", success: "check_circle", error: "error" };
  const el = h("div", { class: `toast ${type}`, role: type === "error" ? "alert" : "status" },
    icon(icons[type]), h("span", {}, message),
    link && h("a", { href: link.href, target: "_blank", rel: "noopener" }, link.text));
  $("toasts").append(el);
  setTimeout(() => el.remove(), type === "error" ? 7000 : 4000);
}

function confirmDialog(title, text, okLabel) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = okLabel;
  const dialog = $("confirm");
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

// ── Değişiklik takibi ────────────────────────────────────────

function changes() {
  const current = new Map(state.catalog.apps.map((a) => [a.id, a]));
  const added = [], modified = [], removed = [];
  for (const [id, app] of current) {
    if (!state.baseline.has(id)) added.push(app.name || id);
    else if (state.baseline.get(id) !== fingerprint(app)) modified.push(app.name || id);
  }
  for (const id of state.baseline.keys()) if (!current.has(id)) removed.push(id);
  return { added, modified, removed, count: added.length + modified.length + removed.length };
}

function resetBaseline() {
  state.baseline = new Map(state.catalog.apps.map((a) => [a.id, fingerprint(a)]));
}

function rowState(app) {
  if (!state.baseline.has(app.id)) return "new";
  return state.baseline.get(app.id) !== fingerprint(app) ? "changed" : null;
}

// ── Bağlantı ─────────────────────────────────────────────────

function savedConnection() {
  try {
    const conn = JSON.parse(localStorage.getItem(CONN_KEY) || "null");
    const token = sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
    return conn ? { ...conn, token, remember: Boolean(localStorage.getItem(TOKEN_KEY)) } : null;
  } catch {
    return null;
  }
}

function storeConnection({ owner, repo, branch, path, token, remember }) {
  try {
    localStorage.setItem(CONN_KEY, JSON.stringify({ owner, repo, branch, path }));
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    /* Depolama kapalıysa bağlantı yalnızca bu oturumda yaşar. */
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* yok say */ }
}

async function connect(conn) {
  const button = $("btn-connect");
  const error = $("connect-error");
  error.textContent = "";
  button.disabled = true;
  try {
    const client = new GitHubClient(conn);
    await client.checkAccess();
    const file = await client.readCatalog();
    state.mode = "github";
    state.client = client;
    if (file) {
      state.catalog = parseCatalog(file.text);
      state.sha = file.sha;
    } else {
      state.catalog = { catalog_url: defaultCatalogUrl(conn), apps: [] };
      state.sha = null;
      toast(`${conn.path} bulunamadı; ilk yayında oluşturulacak.`);
    }
    storeConnection(conn);
    resetBaseline();
    showCatalog(`${conn.owner}/${conn.repo} · ${conn.branch} · ${conn.path}`);
  } catch (err) {
    error.textContent = err.message;
    if (err instanceof GitHubError && err.status === 401) forgetToken();
  } finally {
    button.disabled = false;
  }
}

function defaultCatalogUrl({ owner, repo, branch, path }) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

async function openLocalFile(file) {
  try {
    state.catalog = parseCatalog(await file.text());
    state.mode = "local";
    state.client = new GitHubClient();  // token'sız; yalnızca herkese açık sürüm bilgisi için
    state.sha = null;
    resetBaseline();
    showCatalog(`Yerel dosya · ${file.name}`);
  } catch (err) {
    $("connect-error").textContent = err.message;
  }
}

async function reload() {
  if (changes().count && !(await confirmDialog(
    "Değişiklikler atılsın mı?", "Yayınlanmamış değişikliklerin kaybolacak.", "Yeniden yükle"))) return;
  if (state.mode !== "github") return;
  try {
    const file = await state.client.readCatalog();
    if (file) {
      state.catalog = parseCatalog(file.text);
      state.sha = file.sha;
    }
    resetBaseline();
    render();
    toast("Katalog yeniden yüklendi.", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function disconnect() {
  if (changes().count && !(await confirmDialog(
    "Bağlantı kesilsin mi?", "Yayınlanmamış değişikliklerin kaybolacak.", "Bağlantıyı kes"))) return;
  forgetToken();
  Object.assign(state, { mode: null, client: null, sha: null, catalog: null });
  $("view-catalog").hidden = true;
  $("view-connect").hidden = false;
  $("topbar-actions").hidden = true;
  $("source-label").hidden = true;
  $("connect-form").token.value = "";
}

// ── Katalog ekranı ───────────────────────────────────────────

function showCatalog(sourceLabel) {
  $("view-connect").hidden = true;
  $("view-catalog").hidden = false;
  $("topbar-actions").hidden = false;
  const label = $("source-label");
  label.hidden = false;
  label.replaceChildren(icon(state.mode === "github" ? "cloud" : "description"), sourceLabel);
  $("btn-publish").hidden = state.mode !== "github";
  $("btn-reload").hidden = state.mode !== "github";
  renderFilters();
  render();
}

function renderFilters() {
  const chip = (group, value, label) => h("button", {
    class: "chip", type: "button", "aria-pressed": String(state.filter[group] === value),
    onclick: () => { state.filter[group] = value; renderFilters(); render(); },
  }, label);
  $("filters").replaceChildren(
    chip("category", "all", "Tümü"),
    ...Object.entries(CATEGORIES).map(([k, v]) => chip("category", k, v)),
    h("span", { class: "chip-sep" }),
    chip("status", "all", "Her durum"),
    ...Object.entries(STATUSES).map(([k, v]) => chip("status", k, v)),
  );
}

function render() {
  const { query, category, status } = state.filter;
  const q = query.trim().toLocaleLowerCase("tr");
  const apps = state.catalog.apps.filter((a) =>
    (category === "all" || a.category === category) &&
    (status === "all" || a.status === status) &&
    (!q || a.name.toLocaleLowerCase("tr").includes(q) || a.id.toLocaleLowerCase("tr").includes(q)));

  const list = $("app-list");
  if (!apps.length) {
    list.replaceChildren(h("div", { class: "empty" }, icon("inventory_2"),
      state.catalog.apps.length ? "Bu filtreye uyan kayıt yok." : "Katalog boş. İlk uygulamayı ekleyerek başla."));
  } else {
    list.replaceChildren(...apps.map(renderRow));
  }

  const { count } = changes();
  $("dirty-pill").hidden = !count;
  $("dirty-pill").textContent = `${count} değişiklik`;
  $("publish-label").textContent = count ? `Yayınla (${count})` : "Yayınla";
  $("btn-publish").disabled = !count;
}

function renderRow(app) {
  const marker = rowState(app);
  const platforms = PLATFORMS.filter((p) => app.platforms.includes(p.key));
  return h("article", { class: `app-row${marker ? " changed" : ""}` },
    h("div", { class: "app-icon" }, icon(ICONS[app.icon] || ICONS.default)),
    h("div", { class: "app-main" },
      h("div", { class: "app-title" },
        h("span", {}, app.name || app.id),
        h("span", { class: `badge badge-${app.status}` }, STATUSES[app.status] || app.status),
        app.hidden && h("span", { class: "badge badge-archived", title: "Mağazada listelenmez" }, "Gizli"),
        marker && h("span", { class: "badge badge-new" }, marker === "new" ? "Yeni" : "Değişti")),
      h("div", { class: "app-meta" },
        h("span", {}, app.id),
        h("span", {}, CATEGORIES[app.category] || app.category),
        app.version && h("span", {}, `v${app.version}`),
        app.release_date && h("span", {}, icon("event"), app.release_date),
        platforms.length > 0 && h("span", { title: platforms.map((p) => p.label).join(", ") },
          ...platforms.map((p) => icon(p.icon))))),
    h("div", { class: "app-actions" },
      h("button", {
        class: "btn btn-icon star", type: "button", "aria-pressed": String(app.featured),
        title: app.featured ? "Vitrinden kaldır" : "Vitrinde öne çıkar",
        onclick: () => toggleFeatured(app),
      }, icon("star")),
      h("button", { class: "btn btn-icon", type: "button", title: "Düzenle", onclick: () => openEditor(app) },
        icon("edit")),
      h("button", { class: "btn btn-icon", type: "button", title: "Sil", onclick: () => removeApp(app) },
        icon("delete"))));
}

function toggleFeatured(app) {
  const enable = !app.featured;
  // Uygulama vitrinde tek bir öğe gösterir; işaret tekil tutulur.
  for (const other of state.catalog.apps) other.featured = false;
  app.featured = enable;
  render();
}

async function removeApp(app) {
  const ok = await confirmDialog(`"${app.name || app.id}" silinsin mi?`,
    "Kayıt katalogdan kaldırılır. Yayınlayana kadar geri almak için sayfayı yeniden yükleyebilirsin.", "Sil");
  if (!ok) return;
  state.catalog.apps = state.catalog.apps.filter((a) => a !== app);
  render();
}

// ── Düzenleyici ──────────────────────────────────────────────

function openEditor(app = null) {
  const draft = structuredClone(app || emptyApp());
  state.editing = { originalId: app ? app.id : null, draft };
  $("editor-title").textContent = app ? `Düzenle: ${app.name || app.id}` : "Yeni uygulama";
  $("editor-error").textContent = "";
  $("editor-body").replaceChildren(...buildEditor(draft, Boolean(app)));
  $("editor").showModal();
}

function field(label, control, key, hint) {
  return h("label", { class: "field", "data-key": key },
    h("span", {}, label), control,
    hint && h("small", { class: "muted" }, hint),
    h("small", { class: "field-error", "data-error": key }));
}

function select(name, options, value) {
  return h("select", { name },
    ...Object.entries(options).map(([k, v]) => h("option", { value: k, selected: k === value }, v)));
}

function buildEditor(draft, isExisting) {
  const iconGrid = h("div", { class: "icon-grid", role: "group", "aria-label": "İkon" },
    ...Object.entries(ICONS).map(([key, name]) => h("button", {
      class: "icon-option", type: "button", "data-icon": key, "aria-pressed": String(draft.icon === key),
      title: key,
      onclick: (e) => {
        draft.icon = key;
        for (const b of iconGrid.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      },
    }, icon(name), key)));

  const releaseInfo = h("p", { class: "release-info", id: "release-info" });
  const fillButton = h("button", {
    class: "btn btn-ghost", type: "button", onclick: () => fillFromRelease(fillButton, releaseInfo),
  }, icon("auto_awesome"), "Son sürümden doldur");

  const platformRows = PLATFORMS.map(({ key, label, icon: iconName }) => {
    const d = draft.downloads[key] || { url: "", size_mb: 0, sha256: "", kind: "" };
    const enabled = draft.platforms.includes(key);
    const kinds = key === "android"
      ? { "": KINDS[""], apk: KINDS.apk }
      : Object.fromEntries(Object.entries(KINDS).filter(([k]) => k !== "apk"));
    const row = h("div", { class: `platform-row${enabled ? "" : " off"}`, "data-platform": key },
      h("label", { class: "check" },
        h("input", {
          type: "checkbox", name: `pf_${key}`, checked: enabled,
          onchange: (e) => row.classList.toggle("off", !e.target.checked),
        }),
        icon(iconName), h("span", {}, label)),
      field("İndirme bağlantısı",
        h("input", { type: "url", name: `url_${key}`, value: d.url, placeholder: "https://github.com/…/releases/download/…" }),
        `dl_${key}`),
      field("Kurulum", select(`kind_${key}`, kinds, d.kind || ""), `kind_${key}`),
      field("Boyut (MB)",
        h("input", { type: "number", name: `size_${key}`, min: "0", step: "0.01", value: d.size_mb || "" }),
        `size_${key}`),
      h("div", { class: "sha" },
        field("SHA-256",
          h("input", { name: `sha_${key}`, value: d.sha256 || "", spellcheck: "false", autocomplete: "off",
                       placeholder: "Son sürümden doldurulur; CLD Hub indirilen dosyayı bununla doğrular" }),
          `sha_${key}`)));
    return row;
  });

  return [
    h("div", { class: "section-title" }, icon("info"), "Temel bilgiler"),
    h("div", { class: "grid-2" },
      field("ID", h("input", { name: "id", value: draft.id, disabled: isExisting, placeholder: "CLD-XX-01012026" }), "id",
        isExisting ? "Kurulu uygulamalar bu ID ile eşleştiği için değiştirilemez." : "Harf, rakam, tire ve alt çizgi."),
      field("Ad", h("input", { name: "name", value: draft.name, placeholder: "CLD Örnek Uygulama" }), "name")),
    h("div", { class: "grid-3" },
      field("Tür", select("category", CATEGORIES, draft.category), "category"),
      field("Durum", select("status", STATUSES, draft.status), "status"),
      field("Sürüm", h("input", { name: "version", value: draft.version, placeholder: "1.0.0" }), "version")),
    h("div", { class: "grid-2" },
      field("Çıkış tarihi", h("input", { type: "date", name: "release_date", value: draft.release_date }), "release_date"),
      h("div", { class: "check-aligned check-stack" },
        h("label", { class: "check" },
          h("input", { type: "checkbox", name: "featured", checked: draft.featured }),
          h("span", {}, "Vitrinde öne çıkar")),
        h("label", { class: "check", title: "Kayıt katalogda kalır ama mağazada listelenmez (ör. CLD Hub'ın kendisi)" },
          h("input", { type: "checkbox", name: "hidden", checked: draft.hidden }),
          h("span", {}, "Mağazada gizle")))),

    h("div", { class: "section-title" }, icon("palette"), "İkon"),
    iconGrid,

    h("div", { class: "section-title" }, icon("description"), "Açıklamalar"),
    field("Türkçe", h("textarea", { name: "description_tr" }, draft.description_tr || ""), "description_tr"),
    field("İngilizce", h("textarea", { name: "description_en" }, draft.description_en || ""), "description_en"),

    h("div", { class: "section-title" }, icon("new_releases"), "Yenilikler (bu sürüm)"),
    h("div", { class: "grid-2" },
      field("Türkçe", h("textarea", { name: "changelog_tr", placeholder: "- Yeni özellik…" },
        draft.changelog?.tr || ""), "changelog_tr"),
      field("İngilizce", h("textarea", { name: "changelog_en", placeholder: "- New feature…" },
        draft.changelog?.en || ""), "changelog_en")),

    h("div", { class: "section-title" }, icon("photo_library"), "Ekran görüntüleri"),
    field("Görsel adresleri", h("textarea", {
      name: "screenshots", placeholder: "Her satıra bir adres (https://…png)",
    }, (draft.screenshots || []).join("\n")), "screenshots",
    "Örn. uygulamanın reposuna yüklediğin görsellerin raw.githubusercontent.com adresleri."),

    h("div", { class: "section-title" }, icon("download"), h("span", { class: "grow" }, "Kaynak ve indirmeler")),
    h("div", { class: "input-with-button" },
      field("GitHub reposu",
        h("input", { name: "github_repo", value: draft.github_repo, placeholder: "coffeelakedevv/uygulama-adi" }),
        "github_repo"),
      h("div", { class: "field-aligned" }, fillButton)),
    releaseInfo,
    h("small", { class: "field-error", "data-error": "downloads" }),
    ...platformRows,
  ];
}

function readEditor(form, draft) {
  const value = (name) => (form.elements[name]?.value ?? "").trim();
  const app = structuredClone(draft);
  if (!form.elements.id.disabled) app.id = value("id");
  Object.assign(app, {
    name: value("name"),
    category: value("category"),
    status: value("status"),
    version: value("version").replace(/^v/i, ""),
    release_date: value("release_date"),
    featured: form.elements.featured.checked,
    hidden: form.elements.hidden.checked,
    description_tr: value("description_tr"),
    description_en: value("description_en"),
    changelog: { tr: value("changelog_tr"), en: value("changelog_en") },
    screenshots: value("screenshots").split(/\s*\n\s*/).filter(Boolean),
    github_repo: value("github_repo"),
    platforms: [],
    downloads: {},
  });
  for (const { key } of PLATFORMS) {
    if (!form.elements[`pf_${key}`].checked) continue;
    app.platforms.push(key);
    const url = value(`url_${key}`);
    if (url) {
      app.downloads[key] = {
        url, size_mb: Number(value(`size_${key}`)) || 0,
        sha256: value(`sha_${key}`).toLowerCase().replace(/^sha256:/, ""), kind: value(`kind_${key}`),
      };
    }
  }
  return app;
}

function showErrors(form, errors) {
  for (const el of form.querySelectorAll("[data-error]")) el.textContent = errors[el.dataset.error] || "";
  for (const el of form.querySelectorAll(".field[data-key]")) {
    el.classList.toggle("invalid", Boolean(errors[el.dataset.key]));
  }
  const count = Object.keys(errors).length;
  $("editor-error").textContent = count ? `${count} alanı düzeltmen gerekiyor.` : "";
  form.querySelector(".field.invalid input, .field.invalid select, .field.invalid textarea")?.focus();
}

function saveEditor(event) {
  event.preventDefault();
  const form = $("editor-form");
  const { originalId, draft } = state.editing;
  const app = readEditor(form, draft);
  const others = state.catalog.apps.filter((a) => a.id !== originalId);
  const errors = validateApp(app, others, originalId);
  showErrors(form, errors);
  if (Object.keys(errors).length) return;

  if (app.featured) for (const other of state.catalog.apps) other.featured = false;
  const index = state.catalog.apps.findIndex((a) => a.id === originalId);
  if (index >= 0) state.catalog.apps[index] = app;
  else state.catalog.apps.unshift(app);
  state.editing = null;
  $("editor").close();
  render();
  toast(`"${app.name}" kaydedildi. Yayınlamayı unutma.`, "success");
}

async function fillFromRelease(button, info) {
  const form = $("editor-form");
  const repo = form.elements.github_repo.value.trim();
  if (!repo) {
    showErrors(form, { github_repo: "Önce GitHub reposunu yaz." });
    return;
  }
  button.disabled = true;
  info.textContent = "Son sürüm alınıyor…";
  try {
    const release = await state.client.latestRelease(repo);
    form.elements.version.value = (release.tag_name || "").replace(/^v/i, "");
    if (release.published_at) form.elements.release_date.value = release.published_at.slice(0, 10);

    const matched = [], unmatched = [];
    for (const asset of release.assets || []) {
      const platform = guessPlatform(asset.name);
      if (!platform) {
        unmatched.push(asset.name);
        continue;
      }
      const label = PLATFORMS.find((p) => p.key === platform).label;
      if (form.elements[`url_${platform}`].value === asset.browser_download_url) {
        const sha = form.elements[`sha_${platform}`];
        if (!sha.value && asset.digest) sha.value = asset.digest.replace(/^sha256:/, "");
        matched.push(`${label}: ${asset.name} (zaten güncel)`);
        continue;
      }
      form.elements[`pf_${platform}`].checked = true;
      form.querySelector(`[data-platform="${platform}"]`).classList.remove("off");
      form.elements[`url_${platform}`].value = asset.browser_download_url;
      form.elements[`size_${platform}`].value = (asset.size / 1048576).toFixed(2);
      // GitHub, release dosyalarının SHA-256 özetini "sha256:…" olarak verir.
      form.elements[`sha_${platform}`].value = (asset.digest || "").replace(/^sha256:/, "");
      const kind = guessKind(asset.name);
      if (form.elements[`kind_${platform}`].querySelector(`option[value="${kind}"]`)) {
        form.elements[`kind_${platform}`].value = kind;
      }
      matched.push(`${label}: ${asset.name}`);
    }
    info.textContent = [
      `${release.tag_name} (${(release.published_at || "").slice(0, 10)})`,
      matched.length ? `Eşleşen: ${matched.join(", ")}` : "Otomatik eşleşen dosya yok.",
      unmatched.length ? `Eşleşmeyen: ${unmatched.join(", ")} (bağlantıyı elle girebilirsin)` : "",
    ].filter(Boolean).join(" · ");
  } catch (err) {
    info.textContent = err.status === 404 ? "Bu repoda yayınlanmış bir sürüm bulunamadı." : err.message;
  } finally {
    button.disabled = false;
  }
}

// ── Yayınlama ve dışa aktarma ────────────────────────────────

function defaultCommitMessage({ added, modified, removed }) {
  const parts = [];
  if (added.length) parts.push(`add ${added.join(", ")}`);
  if (modified.length) parts.push(`update ${modified.join(", ")}`);
  if (removed.length) parts.push(`remove ${removed.join(", ")}`);
  const message = `catalog: ${parts.join("; ")}`;
  return message.length > 72 ? `catalog: ${added.length + modified.length + removed.length} changes` : message;
}

function openPublish() {
  const diff = changes();
  if (!diff.count) return;
  const items = [
    ...diff.added.map((n) => `Eklendi: ${n}`),
    ...diff.modified.map((n) => `Güncellendi: ${n}`),
    ...diff.removed.map((n) => `Silindi: ${n}`),
  ];
  $("change-list").replaceChildren(...items.map((text) => h("li", {}, text)));
  $("commit-message").value = defaultCommitMessage(diff);
  $("publish-error").textContent = "";
  $("publish").showModal();
}

async function publish(event) {
  event.preventDefault();
  const button = $("btn-publish-confirm");
  const message = $("commit-message").value.trim() || defaultCommitMessage(changes());
  button.disabled = true;
  try {
    const result = await state.client.writeCatalog(serializeCatalog(state.catalog), state.sha, message);
    state.sha = result.sha;
    resetBaseline();
    $("publish").close();
    render();
    toast("Katalog yayınlandı. Uygulamalara birkaç dakika içinde ulaşır.", "success",
      { href: result.commitUrl, text: "Commit'i gör" });
  } catch (err) {
    $("publish-error").textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function exportCatalog() {
  const blob = new Blob([serializeCatalog(state.catalog)], { type: "application/json" });
  const link = h("a", { href: URL.createObjectURL(blob), download: "catalog.json" });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  if (state.mode === "local") {
    resetBaseline();
    render();
  }
}

// ── Başlatma ─────────────────────────────────────────────────

function init() {
  const form = $("connect-form");
  const saved = savedConnection();
  if (saved) {
    for (const key of ["owner", "repo", "branch", "path"]) form[key].value = saved[key] || form[key].value;
    form.remember.checked = saved.remember;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const conn = Object.fromEntries(
      ["owner", "repo", "branch", "path", "token"].map((k) => [k, form[k].value.trim()]));
    conn.remember = form.remember.checked;
    const missing = Object.entries(conn).filter(([k, v]) => k !== "remember" && !v);
    if (missing.length) {
      $("connect-error").textContent = "Tüm alanları doldur.";
      return;
    }
    connect(conn);
  });
  $("toggle-token").addEventListener("click", () => {
    const input = form.token;
    input.type = input.type === "password" ? "text" : "password";
    $("toggle-token").firstElementChild.textContent = input.type === "password" ? "visibility" : "visibility_off";
  });
  $("local-file").addEventListener("change", (e) => e.target.files[0] && openLocalFile(e.target.files[0]));

  $("search").addEventListener("input", (e) => { state.filter.query = e.target.value; render(); });
  $("btn-add").addEventListener("click", () => openEditor());
  $("btn-publish").addEventListener("click", openPublish);
  $("btn-export").addEventListener("click", exportCatalog);
  $("btn-reload").addEventListener("click", reload);
  $("btn-disconnect").addEventListener("click", disconnect);
  $("editor-form").addEventListener("submit", saveEditor);
  $("publish-form").addEventListener("submit", publish);
  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => button.closest("dialog").close());
  }

  window.addEventListener("beforeunload", (e) => {
    if (state.catalog && changes().count) e.preventDefault();
  });

  if (saved?.token) {
    form.token.value = saved.token;
    connect({ ...saved });
  }
}

init();
