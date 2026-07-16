// Serverless download redirector.
//
// Release asset filenames embed the version (e.g. UniNotepad_0.5.5_aarch64.dmg),
// so a static link breaks on every release. This function looks up the *latest*
// release from the GitHub API, matches the asset for the requested OS by its
// filename suffix, and 302-redirects to it — giving the site stable URLs like
// /download/mac-arm that always resolve to the newest build.
//
// Runs on Vercel's Node runtime (global fetch available). No build step, no deps.
// CommonJS on purpose: site/ has no package.json, so Vercel treats .js as CJS —
// an `export default` here would fail to parse and 500 every request.
// Set a GITHUB_TOKEN env var to raise the API rate limit (optional; the
// unauthenticated 60/hr per IP is usually enough given the CDN cache below).

const REPO = "ilphs/UniNotepad";

// Each OS key maps to a predicate over the asset filename. Suffix matching keeps
// it version-agnostic. Order-independent: exactly one asset should match.
const MATCHERS = {
  "mac-arm": (n) => n.endsWith("aarch64.dmg"),
  "mac-intel": (n) => n.endsWith("x64.dmg"),
  windows: (n) => n.endsWith("x64_en-US.msi"),
  "windows-exe": (n) => n.endsWith("x64-setup.exe"),
  "linux-deb": (n) => n.endsWith("amd64.deb"),
  "linux-appimage": (n) => n.endsWith("amd64.AppImage"),
  "linux-rpm": (n) => n.endsWith(".rpm"),
};

module.exports = async function handler(req, res) {
  const os = String(req.query.os || "");
  const match = MATCHERS[os];
  if (!match) {
    res.status(404).send(`Unknown OS "${os}". Valid: ${Object.keys(MATCHERS).join(", ")}`);
    return;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "UniNotepad-site",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let release;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!r.ok) {
      res.status(502).send(`GitHub release lookup failed (${r.status})`);
      return;
    }
    release = await r.json();
  } catch (e) {
    res.status(502).send("GitHub release lookup failed");
    return;
  }

  const asset = (release.assets || []).find((a) => match(a.name));
  if (!asset) {
    res.status(404).send(`No matching asset for "${os}" in ${release.tag_name || "latest"}`);
    return;
  }

  // Cache the redirect at the edge for an hour; serve stale for a day while
  // revalidating. A new release propagates within the hour without hammering
  // the API on every visit.
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  res.redirect(302, asset.browser_download_url);
}
