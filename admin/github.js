// GitHub REST API istemcisi. Tüm istekler tarayıcıdan doğrudan api.github.com'a gider.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeUtf8Base64(b64) {
  const binary = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export class GitHubClient {
  constructor({ token = "", owner = "", repo = "", branch = "main", path = "catalog.json" } = {}) {
    Object.assign(this, { token, owner, repo, branch, path });
  }

  async request(method, url, body) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let resp;
    try {
      resp = await fetch(url.startsWith("http") ? url : `${API}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      throw new GitHubError("GitHub'a bağlanılamadı. İnternet bağlantını kontrol et.", 0);
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new GitHubError(describeError(resp.status, data), resp.status);
    }
    return data;
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  get contentsPath() {
    const path = this.path.split("/").map(encodeURIComponent).join("/");
    return `${this.repoPath}/contents/${path}`;
  }

  /** Repoya yazma iznimiz olup olmadığını doğrular. */
  async checkAccess() {
    const repo = await this.request("GET", this.repoPath);
    if (!repo.permissions?.push) {
      throw new GitHubError("Bu token'ın repoya yazma izni yok (Contents: Read and write gerekli).", 403);
    }
    return repo;
  }

  /** Katalog dosyasını okur. Dosya yoksa `null` döner. */
  async readCatalog() {
    try {
      const file = await this.request(
        "GET", `${this.contentsPath}?ref=${encodeURIComponent(this.branch)}`);
      return { text: decodeUtf8Base64(file.content), sha: file.sha };
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /** Katalog dosyasını tek bir commit olarak yazar ve yeni sha'yı döner. */
  async writeCatalog(text, sha, message) {
    const body = { message, content: encodeUtf8Base64(text), branch: this.branch };
    if (sha) body.sha = sha;
    const result = await this.request("PUT", this.contentsPath, body);
    return { sha: result.content.sha, commitUrl: result.commit.html_url };
  }

  /** Bir uygulama reposunun son sürümünü (tag + dosyalar) getirir. */
  async latestRelease(repoFullName) {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) throw new GitHubError("Repo 'kullanıcı/repo' biçiminde olmalı.", 400);
    return this.request(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`);
  }
}

function describeError(status, data) {
  const detail = data?.message ? ` (${data.message})` : "";
  switch (status) {
    case 401: return "Token geçersiz ya da süresi dolmuş.";
    case 403: return `Erişim reddedildi${detail}.`;
    case 404: return "Repo, dal veya dosya bulunamadı. Bilgileri ve token'ın repo erişimini kontrol et.";
    case 409: return "Katalog bu arada başka bir yerden değişmiş. Yeniden yükleyip tekrar dene.";
    case 422: return `GitHub isteği reddetti${detail}.`;
    default: return `GitHub hatası: HTTP ${status}${detail}`;
  }
}
